import { PresenceKind } from '@app/shared-types';
import type { WaChat, WaPresence } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import Avatar from '../../components/Avatar';
import { chatTitle, prettyJid } from './utils';
import { selectChat } from '../ui/uiSlice';
import { selectPresence } from '../whatsapp/waSlice';
import { archiveChat, muteChat } from '../../services/socket';

interface Props {
  chat: WaChat | undefined;
  jid: string;
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

export default function ChatHeader({ chat, jid }: Props) {
  const dispatch = useAppDispatch();
  const presence = useAppSelector(selectPresence(jid));
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
      <Avatar
        name={title}
        jid={jid}
        avatarUrl={chat?.avatarUrl ?? null}
        size="sm"
      />
      <div className="chathdr__info">
        <span className="chathdr__title">{title}</span>
        <span className="chathdr__status">{subtitle}</span>
      </div>
      <div className="chathdr__actions">
        <button
          className="iconbtn"
          title={muted ? 'Réactiver les notifications' : 'Couper les notifications'}
          disabled={!chat}
          onClick={() => muteChat(jid, !muted)}
        >
          {muted ? '🔔' : '🔇'}
        </button>
        <button
          className="iconbtn"
          title={archived ? 'Désarchiver' : 'Archiver'}
          disabled={!chat}
          onClick={() => archiveChat(jid, !archived)}
        >
          {archived ? '📤' : '🗄'}
        </button>
      </div>
    </header>
  );
}
