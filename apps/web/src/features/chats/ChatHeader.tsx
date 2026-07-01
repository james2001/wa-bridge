import { PresenceKind } from '@app/shared-types';
import type { WaChat, WaPresence } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import Avatar from '../../components/Avatar';
import { chatTitle, prettyJid } from './utils';
import { selectChat, toggleInfoPanel, selectInfoPanelOpen } from '../ui/uiSlice';
import { selectPresence } from '../whatsapp/waSlice';
import { archiveChat, muteChat } from '../../services/socket';

interface Props {
  chat: WaChat | undefined;
  jid: string;
  accountId: string;
}

function presenceText(p: WaPresence | undefined): string | null {
  if (!p) return null;
  switch (p.kind) {
    case PresenceKind.COMPOSING:
      return 'en train d’écrire…';
    case PresenceKind.RECORDING:
      return 'en train d’enregistrer…';
    case PresenceKind.AVAILABLE:
      return 'en ligne';
    default:
      return null;
  }
}

export default function ChatHeader({ chat, jid, accountId }: Props) {
  const dispatch = useAppDispatch();
  const presence = useAppSelector(selectPresence(accountId, jid));
  const infoOpen = useAppSelector(selectInfoPanelOpen);
  const title = chat ? chatTitle(chat) : prettyJid(jid);
  const subtitle = presenceText(presence) ?? prettyJid(jid);

  const muted = chat?.muted ?? false;
  const archived = chat?.archived ?? false;

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
          <span className="chathdr__status">{subtitle}</span>
        </div>
      </button>
      <div className="chathdr__actions">
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
