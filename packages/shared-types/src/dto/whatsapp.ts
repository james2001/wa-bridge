import type {
  ConnectionState,
  WaMessageType,
  WaMessageStatus,
  PresenceKind,
} from '../enums';

// Identifiant du compte historique unique. Source de vérité partagée front/back :
// défaut des DTO/handlers et des inputs socket sans accountId (rétro-compat).
export const DEFAULT_ACCOUNT_ID = 'default';

// Un compte WhatsApp lié au pont (multi-compte). Phase 1: un seul, id 'default'.
export interface WaAccount {
  id: string; // identifiant stable ('default' = compte historique unique)
  label: string; // nom affichable choisi par l'utilisateur
  color: string | null; // couleur d'accent UI (badge/onglet), ex. '#25D366'
  phoneJid: string | null; // JID du compte lié (null tant que non lié)
  status: ConnectionState; // réutilise l'enum de connexion
  isDefault: boolean; // true pour le compte 'default'
  sortOrder: number; // ordre d'affichage
}

// GET /api/wa/accounts -> liste des comptes du pont.
export interface WaAccountsResponse {
  accounts: WaAccount[];
  defaultAccountId: string; // toujours 'default' en Phase 1
}

// État de la connexion WhatsApp (Baileys).
export interface WaConnection {
  accountId: string; // compte propriétaire
  state: ConnectionState;
  qr: string | null; // chaîne brute du QR à afficher (quand state === 'qr')
  me: { jid: string; name: string | null } | null; // quand state === 'open'
}

// Contact / interlocuteur (JID WhatsApp: ...@s.whatsapp.net ou ...@g.us).
export interface WaContact {
  accountId: string; // compte propriétaire
  jid: string;
  name: string | null; // nom enregistré, sinon pushName / notify
  isGroup: boolean;
  avatarUrl: string | null;
}

// Une discussion dans la liste.
export interface WaChat {
  accountId: string; // compte propriétaire
  jid: string;
  name: string | null;
  isGroup: boolean;
  unreadCount: number;
  lastMessageTs: number | null; // epoch ms
  lastMessagePreview: string | null;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
  blocked: boolean; // contact bloqué (1:1 ; toujours false pour un groupe)
  avatarUrl: string | null;
  // Communauté WhatsApp: JID de la communauté parente d'un groupe (null sinon) ;
  // isAnnounce = ce groupe est le groupe d'annonces de sa communauté.
  communityJid: string | null;
  isAnnounce: boolean;
}

// Une communauté WhatsApp (regroupe des groupes). Ses groupes membres pointent
// vers `jid` via WaChat.communityJid.
export interface WaCommunity {
  accountId: string; // compte propriétaire
  jid: string; // JID de la communauté (parent)
  name: string | null;
  avatarUrl: string | null; // '/api/wa/avatar/<jid>' (le front ajoute accountId + token)
}

// GET /api/wa/communities?accountId= -> communautés du compte.
export interface WaCommunitiesResponse {
  communities: WaCommunity[];
}

// GET /api/wa/contacts/:jid/about -> bio/statut « À propos » d'un contact.
export interface WaContactAbout {
  status: string | null; // texte « À propos » (null si masqué/indispo)
  setAt: number | null; // epoch ms de dernière mise à jour, si connu
}

// Métadonnées média (téléchargement paresseux via le backend).
export interface WaMediaInfo {
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  mimetype: string | null;
  fileName: string | null;
  caption: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  ptt: boolean; // note vocale
  sizeBytes: number | null;
  // URL servie par le backend (média déchiffré à la demande). Null tant que non demandé.
  url: string | null;
  thumbnailBase64: string | null; // miniature/preview légère
}

// Une réaction (emoji) posée sur un message par un participant.
export interface WaReaction {
  emoji: string;
  senderJid: string | null; // qui a réagi (null = inconnu)
  fromMe: boolean;
}

// Un message WhatsApp normalisé pour l'UI.
export interface WaMessage {
  accountId: string; // compte propriétaire
  id: string; // id du message WhatsApp
  chatJid: string;
  fromMe: boolean;
  senderJid: string | null; // expéditeur réel (utile en groupe)
  senderName: string | null;
  type: WaMessageType;
  text: string | null; // corps texte ou légende média
  timestamp: number; // epoch ms
  status: WaMessageStatus;
  quotedId: string | null; // message cité (réponse)
  media: WaMediaInfo | null;
  reactions: WaReaction[]; // réactions emoji posées sur ce message
  clientId: string | null; // corrélation avec l'écho optimistic
}

// --- REST ---

// GET /api/wa/status
export type WaStatusResponse = WaConnection;

// GET /api/wa/chats
export interface WaChatsResponse {
  chats: WaChat[];
}

// GET /api/wa/chats/:jid/messages?before=&limit=
export interface WaMessagesPage {
  messages: WaMessage[]; // ordre chronologique croissant
  hasMore: boolean;
  nextBefore: number | null; // timestamp à passer pour la page suivante
}

// --- Vue fusionnée par personne (multi-compte) ---
//
// Une « personne » = un contact 1:1 agrégé à travers les comptes liés.
// L'identité transverse est le JID pn `…@s.whatsapp.net` : le même numéro vu
// par plusieurs comptes produit une seule personne. Les groupes en sont exclus.
export interface WaPerson {
  jid: string; // JID pn canonique — identité de la personne (clé transverse)
  name: string | null; // meilleur nom disponible parmi les comptes
  avatarUrl: string | null; // '/api/wa/avatar/<jid>' (le front ajoute accountId + token)
  accountIds: string[]; // comptes où cette personne apparaît (≥ 1)
  primaryAccountId: string; // compte le plus récemment actif (routage avatar/média)
  unreadCount: number; // agrégé (> 0 = nombre, -1 = marqué non lu, 0 = lu)
  lastMessageTs: number | null; // epoch ms — max à travers les comptes
  lastMessagePreview: string | null; // aperçu de la discussion la plus récente
  muted: boolean; // toutes les discussions de la personne sont muettes
  archived: boolean; // toutes les discussions de la personne sont archivées
}

// GET /api/wa/people -> personnes 1:1 agrégées multi-comptes (récentes d'abord).
export interface WaPeopleResponse {
  people: WaPerson[];
}

// GET /api/wa/people/:jid/timeline?before=&limit=
// Timeline fusionnée d'une personne : messages de TOUS ses comptes, triés par
// date. Chaque WaMessage porte son `accountId` (origine). Forme = WaMessagesPage.

// Accusé de réception d'un message sortant, par destinataire
// (panneau « Infos du message »). Les horodatages sont en epoch ms, null si
// l'étape n'a pas (encore) eu lieu.
export interface WaMessageReceipt {
  userJid: string; // destinataire (JID canonicalisé)
  name: string | null; // nom affichable (carnet/pushName), sinon null
  deliveredAt: number | null; // distribué
  readAt: number | null; // lu
  playedAt: number | null; // écouté (note vocale / audio)
}

// GET /api/wa/chats/:jid/messages/:id/info
// Détail des accusés d'un message SORTANT (vide pour un message entrant).
export interface WaMessageInfoResponse {
  accountId: string; // compte propriétaire
  id: string;
  chatJid: string;
  isGroup: boolean;
  sentAt: number; // epoch ms — envoi
  receipts: WaMessageReceipt[];
}

// Un élément média d'une discussion (galerie « Médias, liens et documents »).
export interface WaMediaItem {
  accountId: string; // compte propriétaire
  id: string; // id du message
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  mimetype: string | null;
  fileName: string | null;
  caption: string | null;
  url: string | null; // /api/wa/media/<chatJid>/<id> (servi par le backend, token ?t=)
  thumbnailBase64: string | null;
  timestamp: number; // epoch ms
  fromMe: boolean;
}

// GET /api/wa/chats/:jid/media -> tous les médias d'une discussion (récents d'abord).
export interface WaChatMediaResponse {
  items: WaMediaItem[];
}

// Présence d'un contact.
export interface WaPresence {
  accountId: string; // compte propriétaire
  jid: string;
  kind: PresenceKind;
  at: number; // epoch ms
}

// --- API Agent / LLM (server-to-server, header X-API-Key) ---
//
// Surface dédiée aux intégrations automatisées (agents, LLM). Distincte de
// l'API humaine (JWT) : auth par clé statique, garde-fous d'écriture, audit.

// POST /api/agent/wa/chats/:jid/text — corps de la demande d'envoi de texte.
export interface WaAgentSendTextRequest {
  text: string; // corps du message (1..4096 caractères)
  accountId?: string; // compte émetteur (défaut 'default')
  clientId?: string; // corrélation/idempotence (défaut: UUID généré côté serveur)
  dryRun?: boolean; // true = valide + prévisualise sans envoyer
}

// POST /api/agent/wa/chats/:jid/text — réponse d'envoi (ou de dry-run).
export interface WaAgentSendResponse {
  dryRun: boolean;
  clientId: string; // écho du clientId (généré ou fourni)
  message: WaMessage | null; // null en dry-run, sinon le message envoyé
  // Présent en dry-run: aperçu de ce qui aurait été envoyé (jamais le contenu).
  preview?: { accountId: string; chatJid: string; textLength: number };
}

// GET /api/agent/wa/search — résultats combinés (discussions + messages).
export interface WaAgentSearchResponse {
  chats: WaChat[]; // rempli si scope=chats
  messages: WaMessage[]; // rempli si scope=messages
}
