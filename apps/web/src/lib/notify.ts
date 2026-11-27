// Notifications des messages entrants : notification du navigateur + son
// court. Tout reste local au navigateur (rien n'est envoyé à WhatsApp).
//
// Garde-fous :
// - seulement si l'onglet n'est pas au premier plan ;
// - jamais pour ses propres messages, les messages système, une discussion
//   en muet ;
// - seulement pour un message récent (< 2 min) : pas d'avalanche lors d'un
//   rattrapage d'historique à la reconnexion ;
// - un même message n'est notifié qu'une fois (double livraison LID) ;
// - au plus MAX_BURST notifications par fenêtre de BURST_MS.
import { WaMessageType } from '@app/shared-types';
import type { WaChat, WaMessage } from '@app/shared-types';

const RECENT_MS = 2 * 60 * 1000;
const BURST_MS = 10_000;
const MAX_BURST = 4;
const SOUND_GAP_MS = 2_000;
const SEEN_MAX = 500;

const seen = new Set<string>();
let burst: number[] = [];
let lastSound = 0;
let audioCtx: AudioContext | null = null;

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

// À appeler depuis un clic (les navigateurs l'exigent).
export async function requestNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

function tabInBackground(): boolean {
  return document.visibilityState === 'hidden' || !document.hasFocus();
}

// Bip court (deux notes) généré en WebAudio : aucun fichier à charger.
function playSound(): void {
  const now = Date.now();
  if (now - lastSound < SOUND_GAP_MS) return;
  lastSound = now;
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    audioCtx ??= new Ctx();
    const ctx = audioCtx;
    const t0 = ctx.currentTime;
    [880, 1175].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.15, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.12);
    });
  } catch {
    /* audio indisponible : on se contente de la notification */
  }
}

function previewOf(m: WaMessage): string {
  if (m.text) return m.text.length > 120 ? m.text.slice(0, 117) + '…' : m.text;
  switch (m.type) {
    case WaMessageType.IMAGE:
      return '📷 Photo';
    case WaMessageType.VIDEO:
      return '🎬 Vidéo';
    case WaMessageType.AUDIO:
      return m.media?.ptt ? '🎙️ Message vocal' : '🎵 Audio';
    case WaMessageType.DOCUMENT:
      return '📎 Document';
    case WaMessageType.STICKER:
      return '🏷️ Sticker';
    default:
      return 'Nouveau message';
  }
}

export interface IncomingContext {
  chat: WaChat | undefined; // discussion en cache (nom, muet)
  onOpen: () => void; // clic sur la notification
}

export function notifyIncoming(m: WaMessage, ctx: IncomingContext): void {
  if (m.fromMe || m.type === WaMessageType.SYSTEM) return;
  if (Date.now() - m.timestamp > RECENT_MS) return;
  const key = `${m.accountId}|${m.chatJid}|${m.id}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > SEEN_MAX) {
    const first = seen.values().next().value;
    if (first !== undefined) seen.delete(first);
  }
  if (ctx.chat?.muted) return;
  if (!tabInBackground()) return;

  const now = Date.now();
  burst = burst.filter((t) => now - t < BURST_MS);
  if (burst.length >= MAX_BURST) return;
  burst.push(now);

  playSound();
  if (notificationPermission() !== 'granted') return;

  const chatName = ctx.chat?.name ?? m.chatJid.split('@')[0];
  const isGroup = m.chatJid.endsWith('@g.us');
  const body =
    (isGroup && m.senderName ? `${m.senderName} : ` : '') + previewOf(m);
  try {
    const n = new Notification(chatName, {
      body,
      // Une notification par discussion : la suivante remplace la précédente.
      tag: `${m.accountId}|${m.chatJid}`,
      icon: '/favicon.svg',
    });
    n.onclick = () => {
      window.focus();
      ctx.onOpen();
      n.close();
    };
  } catch {
    /* certains navigateurs mobiles refusent `new Notification` */
  }
}
