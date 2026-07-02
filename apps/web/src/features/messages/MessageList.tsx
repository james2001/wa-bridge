import { useEffect, useMemo, useState } from 'react';
import type { WaMessage } from '@app/shared-types';
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

  return (
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
  );
}
