import { PresenceKind } from '@app/shared-types';
import type { WaChat, WaPresence } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { initials } from '../../lib/format';
import { chatTitle, prettyJid } from './utils';
import { selectChat } from '../ui/uiSlice';
import { selectPresence } from '../whatsapp/waSlice';

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

  return (
    <header className="chathdr">
      <button
        className="iconbtn chathdr__back"
        title="Retour"
        onClick={() => dispatch(selectChat(null))}
      >
        ‹
      </button>
      <div className="avatar avatar--sm">
        {chat?.avatarUrl ? (
          <img src={chat.avatarUrl} alt="" />
        ) : (
          initials(title)
        )}
      </div>
      <div className="chathdr__info">
        <span className="chathdr__title">{title}</span>
        <span className="chathdr__status">{subtitle}</span>
      </div>
    </header>
  );
}
