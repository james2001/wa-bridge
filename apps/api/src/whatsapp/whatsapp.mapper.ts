import {
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  normalizeMessageContent,
} from 'baileys';
import type { proto } from 'baileys';
import {
  WaMessageType,
  WaMessageStatus,
  type WaMediaInfo,
  type WaMessage,
} from '@app/shared-types';

function toBase64(data: Uint8Array | null | undefined): string | null {
  if (!data || data.length === 0) return null;
  return Buffer.from(data).toString('base64');
}

function tsToMs(ts: unknown): number {
  if (typeof ts === 'number') return ts * 1000;
  // Long-like objet { toNumber() } ou string
  const anyTs = ts as { toNumber?: () => number } | string | null | undefined;
  if (anyTs && typeof anyTs === 'object' && typeof anyTs.toNumber === 'function') {
    return anyTs.toNumber() * 1000;
  }
  const n = Number(anyTs ?? 0);
  return Number.isFinite(n) ? n * 1000 : 0;
}

function mapStatus(
  status: number | null | undefined,
  fromMe: boolean,
): WaMessageStatus {
  if (!fromMe) return WaMessageStatus.DELIVERED;
  switch (status) {
    case 0:
      return WaMessageStatus.ERROR;
    case 1:
      return WaMessageStatus.PENDING;
    case 2:
      return WaMessageStatus.SENT;
    case 3:
      return WaMessageStatus.DELIVERED;
    case 4:
      return WaMessageStatus.READ;
    case 5:
      return WaMessageStatus.PLAYED;
    default:
      return WaMessageStatus.SENT;
  }
}

interface Extracted {
  type: WaMessageType;
  text: string | null;
  media: WaMediaInfo | null;
  quotedId: string | null;
}

function contextOf(
  message: proto.IMessage,
  key: string | undefined,
): proto.IContextInfo | undefined {
  if (!key) return undefined;
  const content = (message as Record<string, unknown>)[key] as
    | { contextInfo?: proto.IContextInfo }
    | undefined;
  return content?.contextInfo ?? undefined;
}

function firstString(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Extrait type/texte/média d'un contenu de message WhatsApp.
 *
 * Retourne `null` pour les messages de CONTRÔLE / non-affichables (protocol,
 * reaction, senderKeyDistribution, messageContextInfo seul, pollUpdate,
 * keepInChat, contenu vide). Ces messages ne doivent pas produire de bulle.
 *
 * Le contenu est d'abord NORMALISÉ via `normalizeMessageContent` pour déballer
 * les enveloppes (ephemeral, viewOnce*, documentWithCaption, edited, ...).
 */
function extractContent(
  message: proto.IMessage | null | undefined,
): Extracted | null {
  const content = message ? normalizeMessageContent(message) : null;
  if (!content) return null;

  const ctype = getContentType(content);
  // Aucun contenu affichable détecté (ex: messageContextInfo seul,
  // senderKeyDistributionMessage seul, message vide) -> ignoré.
  if (!ctype) return null;

  // Messages de contrôle / non-affichables -> ignorés (pas de bulle).
  switch (ctype) {
    case 'protocolMessage':
    case 'reactionMessage':
    case 'senderKeyDistributionMessage':
    case 'messageContextInfo':
    case 'pollUpdateMessage':
    case 'keepInChatMessage':
      return null;
    default:
      break;
  }

  const quotedId = contextOf(content, ctype)?.stanzaId ?? null;

  // Sondages -> texte "📊 Sondage: <titre>" (pollCreationMessage[V2|V3|...]).
  if (ctype.startsWith('pollCreationMessage')) {
    const poll = (content as Record<string, unknown>)[ctype] as
      | { name?: string | null }
      | undefined;
    const title = poll?.name?.trim();
    return {
      type: WaMessageType.TEXT,
      text: title ? `📊 Sondage: ${title}` : '📊 Sondage',
      media: null,
      quotedId,
    };
  }

  if (content.conversation) {
    return { type: WaMessageType.TEXT, text: content.conversation, media: null, quotedId };
  }
  if (content.extendedTextMessage) {
    return {
      type: WaMessageType.TEXT,
      text: content.extendedTextMessage.text ?? null,
      media: null,
      quotedId,
    };
  }
  if (content.imageMessage) {
    const m = content.imageMessage;
    return {
      type: WaMessageType.IMAGE,
      text: m.caption ?? null,
      quotedId,
      media: {
        kind: 'image',
        mimetype: m.mimetype ?? null,
        fileName: null,
        caption: m.caption ?? null,
        durationSec: null,
        width: m.width ?? null,
        height: m.height ?? null,
        ptt: false,
        sizeBytes: m.fileLength ? Number(m.fileLength) : null,
        url: null,
        thumbnailBase64: toBase64(m.jpegThumbnail),
      },
    };
  }
  if (content.videoMessage) {
    const m = content.videoMessage;
    return {
      type: WaMessageType.VIDEO,
      text: m.caption ?? null,
      quotedId,
      media: {
        kind: 'video',
        mimetype: m.mimetype ?? null,
        fileName: null,
        caption: m.caption ?? null,
        durationSec: m.seconds ?? null,
        width: m.width ?? null,
        height: m.height ?? null,
        ptt: false,
        sizeBytes: m.fileLength ? Number(m.fileLength) : null,
        url: null,
        thumbnailBase64: toBase64(m.jpegThumbnail),
      },
    };
  }
  if (content.audioMessage) {
    const m = content.audioMessage;
    return {
      type: WaMessageType.AUDIO,
      text: null,
      quotedId,
      media: {
        kind: 'audio',
        mimetype: m.mimetype ?? null,
        fileName: null,
        caption: null,
        durationSec: m.seconds ?? null,
        width: null,
        height: null,
        ptt: Boolean(m.ptt),
        sizeBytes: m.fileLength ? Number(m.fileLength) : null,
        url: null,
        thumbnailBase64: null,
      },
    };
  }
  if (content.documentMessage) {
    const m = content.documentMessage;
    return {
      type: WaMessageType.DOCUMENT,
      text: m.caption ?? null,
      quotedId,
      media: {
        kind: 'document',
        mimetype: m.mimetype ?? null,
        fileName: m.fileName ?? m.title ?? null,
        caption: m.caption ?? null,
        durationSec: null,
        width: null,
        height: null,
        ptt: false,
        sizeBytes: m.fileLength ? Number(m.fileLength) : null,
        url: null,
        thumbnailBase64: toBase64(m.jpegThumbnail),
      },
    };
  }
  if (content.stickerMessage) {
    const m = content.stickerMessage;
    return {
      type: WaMessageType.STICKER,
      text: null,
      quotedId,
      media: {
        kind: 'sticker',
        mimetype: m.mimetype ?? null,
        fileName: null,
        caption: null,
        durationSec: null,
        width: m.width ?? null,
        height: m.height ?? null,
        ptt: false,
        sizeBytes: m.fileLength ? Number(m.fileLength) : null,
        url: null,
        thumbnailBase64: null,
      },
    };
  }
  if (content.locationMessage || content.liveLocationMessage) {
    const caption = content.liveLocationMessage?.caption ?? null;
    return { type: WaMessageType.LOCATION, text: caption, media: null, quotedId };
  }
  if (content.contactMessage || content.contactsArrayMessage) {
    return { type: WaMessageType.CONTACT, text: null, media: null, quotedId };
  }

  // --- Best-effort: extraire un texte pour les types interactifs courants ---

  // Réponses à des boutons / listes -> texte sélectionné.
  if (content.buttonsResponseMessage) {
    const r = content.buttonsResponseMessage;
    return {
      type: WaMessageType.TEXT,
      text: firstString(r.selectedDisplayText, r.selectedButtonId),
      media: null,
      quotedId,
    };
  }
  if (content.templateButtonReplyMessage) {
    const r = content.templateButtonReplyMessage;
    return {
      type: WaMessageType.TEXT,
      text: firstString(r.selectedDisplayText, r.selectedId),
      media: null,
      quotedId,
    };
  }
  if (content.listResponseMessage) {
    const r = content.listResponseMessage;
    return {
      type: WaMessageType.TEXT,
      text: firstString(r.title, r.singleSelectReply?.selectedRowId),
      media: null,
      quotedId,
    };
  }

  // Messages porteurs de boutons / templates / listes -> texte principal.
  if (content.buttonsMessage) {
    const b = content.buttonsMessage;
    return {
      type: WaMessageType.TEXT,
      text: firstString(b.contentText, b.text, b.footerText),
      media: null,
      quotedId,
    };
  }
  if (content.templateMessage) {
    const t = content.templateMessage;
    const h = t.hydratedTemplate ?? t.hydratedFourRowTemplate;
    return {
      type: WaMessageType.TEXT,
      text: firstString(
        h?.hydratedContentText,
        h?.hydratedTitleText,
        h?.hydratedFooterText,
      ),
      media: null,
      quotedId,
    };
  }
  if (content.interactiveMessage) {
    const i = content.interactiveMessage;
    return {
      type: WaMessageType.TEXT,
      text: firstString(i.body?.text, i.header?.title, i.footer?.text),
      media: null,
      quotedId,
    };
  }
  if (content.listMessage) {
    const l = content.listMessage;
    return {
      type: WaMessageType.TEXT,
      text: firstString(l.title, l.description, l.buttonText),
      media: null,
      quotedId,
    };
  }

  // Invitation à un groupe.
  if (content.groupInviteMessage) {
    const g = content.groupInviteMessage;
    return {
      type: WaMessageType.TEXT,
      text: `📩 Invitation au groupe ${g.groupName ?? ''}`.trim(),
      media: null,
      quotedId,
    };
  }

  // Vraiment rien d'exploitable -> non supporté (devrait être rare désormais).
  return { type: WaMessageType.UNSUPPORTED, text: null, media: null, quotedId };
}

/** Mappe un message Baileys (proto.IWebMessageInfo) vers le DTO WaMessage. */
export function mapWaMessage(
  m: proto.IWebMessageInfo,
  meId?: string | null,
): WaMessage | null {
  const remoteJid = m.key?.remoteJid;
  const id = m.key?.id;
  if (!remoteJid || !id) return null;

  const fromMe = Boolean(m.key?.fromMe);
  const group = isJidGroup(remoteJid);

  let senderJid: string | null;
  if (group) {
    senderJid = m.key?.participant
      ? jidNormalizedUser(m.key.participant)
      : null;
  } else if (fromMe) {
    senderJid = meId ? jidNormalizedUser(meId) : null;
  } else {
    senderJid = jidNormalizedUser(remoteJid);
  }

  const extracted = extractContent(m.message);
  // Message de contrôle / non-affichable -> ignoré (pas de bulle).
  if (!extracted) return null;
  const { type, text, media, quotedId } = extracted;

  return {
    id,
    chatJid: remoteJid,
    fromMe,
    senderJid,
    senderName: m.pushName ?? null,
    type,
    text,
    timestamp: tsToMs(m.messageTimestamp),
    status: mapStatus(m.status as number | null | undefined, fromMe),
    quotedId,
    media,
    reactions: [],
    clientId: null,
  };
}

/** Aperçu court d'un message pour la liste des discussions. */
export function previewOf(msg: WaMessage): string {
  if (msg.text) return msg.text;
  switch (msg.type) {
    case WaMessageType.IMAGE:
      return '📷 Photo';
    case WaMessageType.VIDEO:
      return '🎬 Vidéo';
    case WaMessageType.AUDIO:
      return msg.media?.ptt ? '🎙️ Message vocal' : '🎵 Audio';
    case WaMessageType.DOCUMENT:
      return `📎 ${msg.media?.fileName ?? 'Document'}`;
    case WaMessageType.STICKER:
      return '🩷 Sticker';
    case WaMessageType.LOCATION:
      return '📍 Position';
    case WaMessageType.CONTACT:
      return '👤 Contact';
    default:
      return 'Message';
  }
}
