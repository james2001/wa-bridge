import type { WaChat } from '@app/shared-types';

// Partie utile d'un JID WhatsApp (ex: '33612345678@s.whatsapp.net' -> '33612345678').
export function prettyJid(jid: string): string {
  const at = jid.indexOf('@');
  return at >= 0 ? jid.slice(0, at) : jid;
}

// Meta AI et autres bots WhatsApp : non pris en charge par wa-bridge (Baileys
// ne sait ni leur écrire ni lire leurs réponses).
export function isMetaAiJid(jid: string): boolean {
  return (
    /^(1313555\d{4}|131655500\d{2})@s\.whatsapp\.net$/.test(jid) ||
    jid.endsWith('@bot')
  );
}

// Titre affiché: nom enregistré sinon JID lisible.
export function chatTitle(chat: WaChat): string {
  if (chat.name && chat.name.trim().length > 0) return chat.name;
  return prettyJid(chat.jid);
}
