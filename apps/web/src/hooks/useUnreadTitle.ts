import { useEffect } from 'react';
import { useAppSelector } from '../app/hooks';
import { useGetChatsQuery } from '../features/chats/chatsApi';
import { selectActiveAccountId } from '../features/ui/uiSlice';

const BASE_TITLE = 'wa-bridge';

// Titre de l'onglet « (N) wa-bridge » : N = discussions non lues du compte
// affiché, hors archivées et muettes (comme WhatsApp Web).
export function useUnreadTitle(): void {
  const accountId = useAppSelector(selectActiveAccountId);
  const { data: chats } = useGetChatsQuery(accountId);
  const count = (chats ?? []).filter(
    (c) =>
      !c.archived && !c.muted && (c.unreadCount > 0 || c.unreadCount === -1),
  ).length;
  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [count]);
}
