import { lazy, Suspense, useState } from 'react';
import { WaMessageStatus, WaMessageType } from '@app/shared-types';
import type { WaMessage, WaReaction } from '@app/shared-types';
import { formatTime } from '../../lib/format';
import MediaContent from './MediaContent';
import MessageInfoModal from './MessageInfoModal';
import DeleteMessageModal from './DeleteMessageModal';
import { reactToMessage } from '../../services/socket';
import { useAppDispatch } from '../../app/hooks';
import { setComposerAction } from '../ui/uiSlice';

// Chargé à la demande : la bibliothèque d'emojis pèse plusieurs centaines de Ko.
const EmojiPanel = lazy(() => import('../../components/EmojiPanel'));

// Délai de modification d'un message (règle WhatsApp, revérifiée côté serveur).
const EDIT_WINDOW_MS = 15 * 60 * 1000;
// Délai « supprimer pour tout le monde » (revérifié côté serveur).
const REVOKE_WINDOW_MS = 48 * 60 * 60 * 1000;

interface Props {
  message: WaMessage;
  // Message cité résolu (réponse). null = quotedId présent mais introuvable.
  quoted?: WaMessage | null;
  // Vue fusionnée par personne : affiche « via <compte> » sous la bulle. Activé
  // uniquement quand la conversation couvre plusieurs comptes (cf. PersonTimeline).
  showAccount?: boolean;
  accountLabel?: string;
  accountColor?: string | null;
}

// Réaction agrégée pour l'affichage: un emoji, son compteur, et un drapeau
// indiquant que l'utilisateur courant en fait partie (mise en évidence).
interface GroupedReaction {
  emoji: string;
  count: number;
  fromMe: boolean;
}

// Regroupe les réactions par emoji (préserve l'ordre de première apparition).
function groupReactions(reactions: WaReaction[]): GroupedReaction[] {
  const order: string[] = [];
  const map = new Map<string, GroupedReaction>();
  for (const r of reactions) {
    const existing = map.get(r.emoji);
    if (existing) {
      existing.count += 1;
      existing.fromMe = existing.fromMe || r.fromMe;
    } else {
      map.set(r.emoji, { emoji: r.emoji, count: 1, fromMe: r.fromMe });
      order.push(r.emoji);
    }
  }
  return order.map((e) => map.get(e) as GroupedReaction);
}

// Coche(s) WhatsApp selon le statut (uniquement pour les messages sortants).
function statusMark(status: WaMessageStatus): string {
  switch (status) {
    case WaMessageStatus.PENDING:
      return '🕓';
    case WaMessageStatus.SENT:
      return '✓';
    case WaMessageStatus.DELIVERED:
      return '✓✓';
    case WaMessageStatus.READ:
    case WaMessageStatus.PLAYED:
      return '✓✓';
    case WaMessageStatus.ERROR:
      return '⚠';
    default:
      return '';
  }
}

// Texte de remplacement pour les types non-texte (rendu média réel plus tard).
function mediaPlaceholder(message: WaMessage): string | null {
  switch (message.type) {
    case WaMessageType.TEXT:
      return null;
    case WaMessageType.IMAGE:
      return '📷 Photo';
    case WaMessageType.VIDEO:
      return '🎬 Vidéo';
    case WaMessageType.AUDIO:
      return message.media?.ptt ? '🎙️ Message vocal' : '🎵 Audio';
    case WaMessageType.DOCUMENT:
      return message.media?.fileName
        ? `📎 Document ${message.media.fileName}`
        : '📎 Document';
    case WaMessageType.STICKER:
      return '🏷️ Sticker';
    case WaMessageType.LOCATION:
      return '📍 Position';
    case WaMessageType.CONTACT:
      return '👤 Contact';
    case WaMessageType.SYSTEM:
      return null;
    default:
      // Type inconnu: rendu discret géré séparément (cf. isUnsupported).
      return null;
  }
}

// Détecte un type de message non géré (rendu discret en italique grisé).
function isUnsupported(type: WaMessageType): boolean {
  switch (type) {
    case WaMessageType.TEXT:
    case WaMessageType.IMAGE:
    case WaMessageType.VIDEO:
    case WaMessageType.AUDIO:
    case WaMessageType.DOCUMENT:
    case WaMessageType.STICKER:
    case WaMessageType.LOCATION:
    case WaMessageType.CONTACT:
    case WaMessageType.SYSTEM:
      return false;
    default:
      return true;
  }
}

// Aperçu textuel d'un message cité: extrait du texte, sinon libellé média.
function quotedPreview(q: WaMessage): string {
  if (q.media) {
    switch (q.media.kind) {
      case 'image':
        return '📷 Photo';
      case 'video':
        return '🎬 Vidéo';
      case 'audio':
        return q.media.ptt ? '🎙️ Vocal' : '🎵 Audio';
      case 'document':
        return '📎 Document';
      case 'sticker':
        return '🏷️ Sticker';
    }
  }
  if (q.text) return q.text;
  switch (q.type) {
    case WaMessageType.IMAGE:
      return '📷 Photo';
    case WaMessageType.VIDEO:
      return '🎬 Vidéo';
    case WaMessageType.AUDIO:
      return '🎙️ Vocal';
    case WaMessageType.DOCUMENT:
      return '📎 Document';
    default:
      return 'Message';
  }
}

export default function MessageBubble({
  message,
  quoted,
  showAccount = false,
  accountLabel,
  accountColor,
}: Props) {
  const dispatch = useAppDispatch();
  const isOwn = message.fromMe;
  // Panneau « Infos du message » (accusés de réception), messages sortants.
  const [infoOpen, setInfoOpen] = useState(false);
  const isRead =
    message.status === WaMessageStatus.READ ||
    message.status === WaMessageStatus.PLAYED;
  const isFailed = message.status === WaMessageStatus.ERROR;
  // Quand un média est présent, MediaContent prend le relais (rendu réel +
  // légende). Sinon on retombe sur le placeholder texte (location, contact…).
  const hasMedia = message.media != null;
  const placeholder = hasMedia ? null : mediaPlaceholder(message);
  const unsupported = isUnsupported(message.type);
  const reactions = groupReactions(message.reactions);
  // Nom de l'expéditeur affiché uniquement pour un message entrant en groupe.
  const isGroup = message.chatJid.endsWith('@g.us');
  const showSender = !isOwn && isGroup;
  const senderLabel = message.senderName ?? message.senderJid ?? 'Contact';
  // Encart "réponse" si le message cite un autre message.
  const hasQuote = message.quotedId != null;
  const quoteSender = quoted
    ? quoted.fromMe
      ? 'Vous'
      : quoted.senderName ?? 'Contact'
    : '';
  const quoteText = quoted ? quotedPreview(quoted) : 'Message';

  // Réactions : seulement sur un message réellement envoyé/reçu (pas l'écho
  // optimistic en attente, ni un message en échec ou système).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reactError, setReactError] = useState<string | null>(null);
  const canReact =
    message.status !== WaMessageStatus.PENDING &&
    message.status !== WaMessageStatus.ERROR &&
    message.type !== WaMessageType.SYSTEM;
  // Actions possibles sur un message réellement envoyé/reçu.
  const canAct =
    message.status !== WaMessageStatus.PENDING &&
    message.status !== WaMessageStatus.ERROR;
  const [deleteOpen, setDeleteOpen] = useState(false);
  // « Pour tout le monde » : ses propres messages, non déjà supprimés, < 48 h
  // (le serveur revérifie).
  const canRevoke =
    canReact && isOwn && Date.now() - message.timestamp < REVOKE_WINDOW_MS;
  const myReaction = message.reactions.find((r) => r.fromMe)?.emoji ?? null;
  // Modifiable : son propre message texte envoyé il y a moins de 15 min
  // (le serveur revérifie tout).
  const canEdit =
    canReact &&
    isOwn &&
    message.type === WaMessageType.TEXT &&
    Date.now() - message.timestamp < EDIT_WINDOW_MS;
  const onReact = (emoji: string) => {
    setPickerOpen(false);
    // Re-choisir sa réaction actuelle la retire (comme WhatsApp).
    const next = emoji === myReaction ? '' : emoji;
    reactToMessage(message.accountId, message.chatJid, message.id, next)
      .then((ack) => {
        if (!ack.ok) setReactError(ack.error ?? 'Échec');
      })
      .catch(() => setReactError('WhatsApp injoignable'));
  };

  return (
    <div className={'bubblerow' + (isOwn ? ' bubblerow--own' : '')}>
      {canAct && (
        <div className="bubblerow__react">
          {canReact && (
          <>
          <button
            type="button"
            className="react-trigger"
            title="Réagir"
            aria-label="Réagir à ce message"
            aria-expanded={pickerOpen}
            onClick={() => {
              setReactError(null);
              setPickerOpen((v) => !v);
            }}
          >
            ☺
          </button>
          <button
            type="button"
            className="react-trigger"
            title="Répondre"
            aria-label="Répondre à ce message"
            onClick={() =>
              dispatch(
                setComposerAction({
                  kind: 'reply',
                  chatJid: message.chatJid,
                  message,
                }),
              )
            }
          >
            ↩
          </button>
          </>
          )}
          {canEdit && (
            <button
              type="button"
              className="react-trigger"
              title="Modifier"
              aria-label="Modifier ce message"
              onClick={() =>
                dispatch(
                  setComposerAction({
                    kind: 'edit',
                    chatJid: message.chatJid,
                    message,
                  }),
                )
              }
            >
              ✎
            </button>
          )}
          <button
            type="button"
            className="react-trigger"
            title="Supprimer"
            aria-label="Supprimer ce message"
            onClick={() => setDeleteOpen(true)}
          >
            🗑
          </button>
          {pickerOpen && (
            <Suspense fallback={null}>
              <EmojiPanel
                reactions
                className="emojipanel--react"
                onPick={onReact}
                onClose={() => setPickerOpen(false)}
              />
            </Suspense>
          )}
        </div>
      )}
      <div
        className={
          'bubble' +
          (isOwn ? ' bubble--own' : '') +
          (isFailed ? ' bubble--failed' : '') +
          (reactions.length > 0 ? ' bubble--has-reactions' : '')
        }
      >
        {/* Déclencheur « Infos du message »: messages sortants uniquement,
            discret, visible au survol de la bulle (cf. CSS .bubble__action). */}
        {isOwn && (
          <button
            type="button"
            className="bubble__action"
            aria-label="Infos du message"
            title="Infos du message"
            onClick={() => setInfoOpen(true)}
          >
            ⓘ
          </button>
        )}
        {showSender && <span className="bubble__sender">{senderLabel}</span>}
        {hasQuote && (
          <div className="bubble__quote">
            {quoteSender && (
              <span className="bubble__quote-sender">{quoteSender}</span>
            )}
            <span className="bubble__quote-text">{quoteText}</span>
          </div>
        )}
        {hasMedia && <MediaContent message={message} />}
        {placeholder && <span className="bubble__media">{placeholder}</span>}
        {unsupported && (
          <span className="bubble__unsupported">Message non pris en charge</span>
        )}
        {/* La légende du média est rendue par MediaContent: on n'affiche le
            corps texte ici que pour les messages sans média. */}
        {!hasMedia && message.text && (
          <span className="bubble__body">{message.text}</span>
        )}
        <span className="bubble__meta">
          {message.edited && <span className="bubble__edited">modifié</span>}
          <span className="bubble__time">{formatTime(message.timestamp)}</span>
          {isOwn && (
            <span
              className={
                'bubble__check' + (isRead ? ' bubble__check--read' : '')
              }
            >
              {statusMark(message.status)}
            </span>
          )}
        </span>
        {showAccount && accountLabel && (
          <span
            className="bubble__account"
            style={accountColor ? { color: accountColor } : undefined}
            title={`Compte : ${accountLabel}`}
          >
            via {accountLabel}
          </span>
        )}
        {reactError && (
          <span className="bubble__react-error" role="alert">
            Réaction non envoyée : {reactError}
          </span>
        )}
        {reactions.length > 0 && (
          <div className="bubble__reactions">
            {reactions.map((r) => (
              <span
                key={r.emoji}
                className={
                  'reaction-chip' + (r.fromMe ? ' reaction-chip--own' : '')
                }
                title={r.fromMe ? 'Votre réaction' : undefined}
              >
                <span className="reaction-chip__emoji">{r.emoji}</span>
                {r.count > 1 && (
                  <span className="reaction-chip__count">{r.count}</span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
      {deleteOpen && (
        <DeleteMessageModal
          message={message}
          canRevoke={canRevoke}
          onClose={() => setDeleteOpen(false)}
        />
      )}
      {infoOpen && (
        <MessageInfoModal message={message} onClose={() => setInfoOpen(false)} />
      )}
    </div>
  );
}
