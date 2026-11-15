import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { selectFocusMessage, setFocusMessage } from '../ui/uiSlice';
import type { WaMessage } from '@app/shared-types';
import { markRead } from '../../services/socket';
import { useGetMessagesQuery } from './messagesApi';
import MessageBubble from './MessageBubble';
import MessageScroller from './MessageScroller';

interface Props {
  jid: string;
  accountId: string;
}

// Fil de messages d'une discussion (par compte). Charge/pagine via RTK Query et
// délègue le défilement à MessageScroller.
export default function MessageList({ jid, accountId }: Props) {
  // `before` pilote la pagination: undefined = page la plus récente.
  const [before, setBefore] = useState<number | undefined>(undefined);
  const { data, isLoading, isError, isFetching } = useGetMessagesQuery({
    accountId,
    jid,
    before,
  });

  const messages = useMemo(
    () =>
      data ? [...data.messages].sort((a, b) => a.timestamp - b.timestamp) : [],
    [data],
  );

  // Index id -> message pour résoudre l'aperçu d'une réponse citée (quotedId).
  const messagesById = useMemo(() => {
    const map = new Map<string, WaMessage>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  const hasMore = data?.hasMore ?? false;
  const nextBefore = data?.nextBefore ?? null;

  // Remet le curseur à la page récente en changeant de discussion.
  useEffect(() => {
    setBefore(undefined);
  }, [jid]);

  // Marque lu quand un nouveau message ENTRANT arrive dans la discussion ouverte
  // (comportement WhatsApp Web). Se déclenche à l'ouverture et à chaque nouvel
  // entrant, mais PAS sur un simple changement de statut (l'id ne change pas).
  const lastIncomingId =
    messages.length > 0 && !messages[messages.length - 1].fromMe
      ? messages[messages.length - 1].id
      : null;
  useEffect(() => {
    if (lastIncomingId) markRead(accountId, jid);
  }, [accountId, jid, lastIncomingId]);

  // Aller à un message (résultat de recherche) : défile jusqu'à lui et le
  // met en évidence ; s'il est plus ancien, charge les pages précédentes
  // (lecture seule) jusqu'à le trouver, dans la limite de MAX_PAGES.
  const dispatch = useAppDispatch();
  const focus = useAppSelector(selectFocusMessage);
  const pagesLoaded = useRef(0);
  const [focusMissed, setFocusMissed] = useState(false);
  useEffect(() => {
    if (!focus || focus.chatJid !== jid) return;
    const el = document.querySelector<HTMLElement>(
      `[data-msg-id="${CSS.escape(focus.id)}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('bubblerow--flash');
      setTimeout(() => el.classList.remove('bubblerow--flash'), 2500);
      pagesLoaded.current = 0;
      setFocusMissed(false);
      dispatch(setFocusMessage(null));
      return;
    }
    if (isFetching) return;
    if (hasMore && nextBefore != null && pagesLoaded.current < MAX_PAGES) {
      pagesLoaded.current += 1;
      setBefore(nextBefore);
      return;
    }
    pagesLoaded.current = 0;
    setFocusMissed(true);
    dispatch(setFocusMessage(null));
  }, [focus, jid, messages, isFetching, hasMore, nextBefore, dispatch]);

  return (
    <>
    {focusMissed && (
      <button
        type="button"
        className="msglist__missed"
        onClick={() => setFocusMissed(false)}
      >
        Message trop ancien pour être affiché ici — remontez la conversation. ✕
      </button>
    )}
    <MessageScroller
      resetKey={jid}
      messages={messages}
      isLoading={isLoading}
      isError={isError}
      isFetching={isFetching}
      loadingOlder={isFetching && before != null}
      hasMore={hasMore}
      nextBefore={nextBefore}
      onLoadOlder={() => {
        if (nextBefore != null) setBefore(nextBefore);
      }}
      renderBubble={(m) => (
        <MessageBubble
          key={m.clientId ?? m.id}
          message={m}
          quoted={m.quotedId ? messagesById.get(m.quotedId) ?? null : null}
        />
      )}
    />
    </>
  );
}

// Pages plus anciennes chargées au plus pour retrouver un message cherché.
const MAX_PAGES = 15;
