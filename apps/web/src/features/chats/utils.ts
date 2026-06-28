import type { WaChat } from '@app/shared-types';

// Partie utile d'un JID WhatsApp (ex: '33612345678@s.whatsapp.net' -> '33612345678').
export function prettyJid(jid: string): string {
  const at = jid.indexOf('@');
  return at >= 0 ? jid.slice(0, at) : jid;
}

// Titre affiché: nom enregistré sinon JID lisible.
export function chatTitle(chat: WaChat): string {
  if (chat.name && chat.name.trim().length > 0) return chat.name;
  return prettyJid(chat.jid);
}
