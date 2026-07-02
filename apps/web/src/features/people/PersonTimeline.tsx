import { useEffect, useMemo, useState } from 'react';
import type { WaMessage } from '@app/shared-types';
import { useAppSelector } from '../../app/hooks';
import { selectAccounts } from '../whatsapp/waSlice';
import MessageBubble from '../messages/MessageBubble';
import MessageScroller from '../messages/MessageScroller';
import { useGetPersonTimelineQuery } from './peopleApi';

interface Props {
  jid: string;
  // La conversation couvre-t-elle plusieurs comptes ? Si oui, chaque bulle
  // affiche « via <compte> ».
  showAccount: boolean;
}

// Clé de résolution d'une citation dans une timeline fusionnée : un quotedId
// réfère un message du MÊME compte (les ids ne sont pas comparables entre comptes).
const quoteKey = (accountId: string, id: string) => `${accountId} ${id}`;

// Timeline fusionnée d'une personne (lecture seule). Charge/pagine via RTK Query
// et délègue le défilement à MessageScroller (mutualisé avec MessageList).
export default function PersonTimeline({ jid, showAccount }: Props) {
  const accounts = useAppSelector(selectAccounts);
  const [before, setBefore] = useState<number | undefined>(undefined);
  const { data, isLoading, isError, isFetching } = useGetPersonTimelineQuery({
    jid,
    before,
  });

  const messages = useMemo(
    () =>
      data ? [...data.messages].sort((a, b) => a.timestamp - b.timestamp) : [],
    [data],
  );

  const messagesById = useMemo(() => {
    const map = new Map<string, WaMessage>();
    for (const m of messages) map.set(quoteKey(m.accountId, m.id), m);
    return map;
  }, [messages]);

  const acctById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );

  const hasMore = data?.hasMore ?? false;
  const nextBefore = data?.nextBefore ?? null;

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
      emptyLabel="Aucun message avec cette personne."
      renderBubble={(m) => {
        const acc = acctById.get(m.accountId);
        return (
          <MessageBubble
            key={quoteKey(m.accountId, m.id)}
            message={m}
            quoted={
              m.quotedId
                ? messagesById.get(quoteKey(m.accountId, m.quotedId)) ?? null
                : null
            }
            showAccount={showAccount}
            accountLabel={acc?.label ?? m.accountId}
            accountColor={acc?.color ?? null}
          />
        );
      }}
    />
  );
}
