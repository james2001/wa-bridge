// Énumérations partagées (objets `as const` => valeur runtime + type).

// État de la connexion Baileys <-> WhatsApp.
export const ConnectionState = {
  CONNECTING: 'connecting',
  QR: 'qr', // un QR est disponible à scanner
  OPEN: 'open', // session liée et active
  CLOSE: 'close', // déconnecté (reconnexion auto en cours)
  LOGGED_OUT: 'logged_out', // session révoquée -> re-scan nécessaire
} as const;
export type ConnectionState =
  (typeof ConnectionState)[keyof typeof ConnectionState];

// Type de message WhatsApp.
export const WaMessageType = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio', // inclut les notes vocales (ptt)
  DOCUMENT: 'document',
  STICKER: 'sticker',
  LOCATION: 'location',
  CONTACT: 'contact',
  SYSTEM: 'system', // messages système (ajout au groupe, etc.)
  UNSUPPORTED: 'unsupported',
} as const;
export type WaMessageType = (typeof WaMessageType)[keyof typeof WaMessageType];

// Statut d'un message (checkmarks WhatsApp).
export const WaMessageStatus = {
  PENDING: 'pending', // optimistic, pas encore confirmé serveur
  SENT: 'sent', // 1 coche (reçu par le serveur WhatsApp)
  DELIVERED: 'delivered', // 2 coches (livré au destinataire)
  READ: 'read', // 2 coches bleues (lu)
  PLAYED: 'played', // note vocale écoutée
  ERROR: 'error',
} as const;
export type WaMessageStatus =
  (typeof WaMessageStatus)[keyof typeof WaMessageStatus];

// Présence d'un contact.
export const PresenceKind = {
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  COMPOSING: 'composing', // en train d'écrire
  RECORDING: 'recording', // en train d'enregistrer un vocal
  PAUSED: 'paused',
} as const;
export type PresenceKind = (typeof PresenceKind)[keyof typeof PresenceKind];
