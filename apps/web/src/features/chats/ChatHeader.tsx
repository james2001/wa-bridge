import { PresenceKind } from '@app/shared-types';
import type { WaChat, WaPresence } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import Avatar from '../../components/Avatar';
import { chatTitle, prettyJid } from './utils';
import { selectChat, toggleInfoPanel, selectInfoPanelOpen } from '../ui/uiSlice';
import { selectPresence } from '../whatsapp/waSlice';
import { archiveChat, muteChat, pinChat } from '../../services/socket';
import { useGetChatsQuery } from './chatsApi';
import { TypingOr } from './Typing';

// Limite WhatsApp (le backend applique la même).
const MAX_PINNED = 3;

interface Props {
  chat: WaChat | undefined;
  jid: string;
  accountId: string;
  onSearch?: () => void;
}

// « écrit… » est rendu par TypingOr ; ici, seulement « en ligne » (pas pour
// un groupe : la présence d'un membre ne dit rien du groupe).
function presenceText(p: WaPresence | undefined, isGroup: boolean): string | null {
  if (!p || isGroup) return null;
  return p.kind === PresenceKind.AVAILABLE ? 'en ligne' : null;
}

export default function ChatHeader({ chat, jid, accountId, onSearch }: Props) {
  const dispatch = useAppDispatch();
  const presence = useAppSelector(selectPresence(accountId, jid));
  const infoOpen = useAppSelector(selectInfoPanelOpen);
  const title = chat ? chatTitle(chat) : prettyJid(jid);
  const subtitle =
    presenceText(presence, chat?.isGroup ?? jid.endsWith('@g.us')) ?? prettyJid(jid);

  const muted = chat?.muted ?? false;
  const archived = chat?.archived ?? false;
  const pinned = chat?.pinned ?? false;
  const { data: chats } = useGetChatsQuery(accountId);
  const pinnedCount = chats?.filter((c) => c.pinned).length ?? 0;
  const pinFull = !pinned && pinnedCount >= MAX_PINNED;

  return (
    <header className="chathdr">
      <button
        className="iconbtn chathdr__back"
        title="Retour"
        onClick={() => dispatch(selectChat(null))}
      >
        ‹
      </button>
      <button
        type="button"
        className="chathdr__id"
        title="Infos du contact"
        aria-expanded={infoOpen}
        aria-controls="info-panel"
        onClick={() => dispatch(toggleInfoPanel())}
      >
        <Avatar
          name={title}
          jid={jid}
          avatarUrl={chat?.avatarUrl ?? null}
          accountId={accountId}
          size="sm"
        />
        <div className="chathdr__info">
          <span className="chathdr__title">{title}</span>
          <span className="chathdr__status">
            <TypingOr accountId={accountId} jid={jid}>
              {subtitle}
            </TypingOr>
          </span>
        </div>
      </button>
      <div className="chathdr__actions">
        {onSearch && (
          <button
            type="button"
            className="iconbtn"
            title="Rechercher dans la discussion"
            aria-label="Rechercher dans la discussion"
            onClick={onSearch}
          >
            🔍
          </button>
        )}
        <button
          className="iconbtn"
          title="Infos du contact"
          aria-expanded={infoOpen}
          aria-controls="info-panel"
          onClick={() => dispatch(toggleInfoPanel())}
        >
          ℹ️
        </button>
        <button
          className={'iconbtn' + (pinned ? ' iconbtn--on' : '')}
          title={
            pinned
              ? 'Désépingler'
              : pinFull
                ? `Déjà ${MAX_PINNED} discussions épinglées`
                : 'Épingler en haut de la liste'
          }
          aria-pressed={pinned}
          disabled={!chat || pinFull}
          onClick={() => pinChat(accountId, jid, !pinned)}
        >
          📌
        </button>
        <button
          className="iconbtn"
          title={muted ? 'Réactiver les notifications' : 'Couper les notifications'}
          disabled={!chat}
          onClick={() => muteChat(accountId, jid, !muted)}
        >
          {muted ? '🔔' : '🔇'}
        </button>
        <button
          className="iconbtn"
          title={archived ? 'Désarchiver' : 'Archiver'}
          disabled={!chat}
          onClick={() => archiveChat(accountId, jid, !archived)}
        >
          {archived ? '📤' : '🗄'}
        </button>
      </div>
    </header>
  );
}
