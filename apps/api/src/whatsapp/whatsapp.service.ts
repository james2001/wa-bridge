import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  isLidUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  proto,
  type ConnectionState as BaileysConnectionState,
  type WASocket,
} from 'baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import {
  ConnectionState,
  PresenceKind,
  WaMessageStatus,
  WaMessageType,
  type WaAccount,
  type WaAccountsResponse,
  type WaChat,
  type WaConnection,
  type WaContactAbout,
  type WaMediaItem,
  type WaMessage,
  type WaMessageInfoResponse,
  type WaMessageReceipt,
  type WaPeopleResponse,
  type WaPerson,
  type WaPresence,
  type WaReaction,
} from '@app/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapWaMessage, previewOf } from './whatsapp.mapper';

// Seuil départageant une durée relative (petite valeur) d'un timestamp epoch ms
// (~1.7e12). Sous ce seuil, muteEndTime est une durée => discussion muette.
const EPOCH_FLOOR_MS = 1_000_000_000_000; // 2001-09-09 en ms

// Compte historique unique (mono-compte). Tout passe par lui en Phase 1.
const DEFAULT_ACCOUNT_ID = 'default';

// Renvoie une chaîne non vide nettoyée, ou null. WhatsApp livre souvent ''
// (chaîne vide) pour un nom absent : avec `??` la chaîne vide passerait à
// travers et serait stockée/affichée comme un nom (=> repli sur le JID brut).
const cleanName = (s: unknown): string | null => {
  const t = typeof s === 'string' ? s.trim() : '';
  return t.length > 0 ? t : null;
};

// Événements domaine émis par le service (consommés par la gateway). Chaque
// signature porte `accountId` en 1er argument (routage multi-compte).
export interface WhatsappEvents {
  // Liste des comptes changée (ajout / suppression / renommage).
  accounts: (p: WaAccountsResponse) => void;
  connection: (accountId: string, conn: WaConnection) => void;
  message: (accountId: string, msg: WaMessage) => void;
  'message-status': (
    accountId: string,
    p: {
      id: string;
      chatJid: string;
      status: WaMessageStatus;
    },
  ) => void;
  chats: (accountId: string, chats: WaChat[]) => void;
  'chat-upsert': (accountId: string, chat: WaChat) => void;
  'history-synced': (accountId: string, p: { chatJid: string | null }) => void;
  reaction: (
    accountId: string,
    p: {
      chatJid: string;
      messageId: string;
      reactions: WaReaction[];
    },
  ) => void;
  presence: (accountId: string, p: WaPresence) => void;
}

// État runtime d'UN compte WhatsApp (socket Baileys + caches mémoire + connexion).
// Stocké dans la Map `sessions` de WhatsappService, clé = accountId.
interface AccountSession {
  accountId: string;
  sock: WASocket | null;
  authDir: string; // dossier auth Baileys propre au compte
  mediaDir: string; // dossier cache média/avatar propre au compte
  connecting: boolean;
  destroyed: boolean;
  connection: WaConnection; // porte désormais accountId
  saveCreds?: () => Promise<void>; // issu de useMultiFileAuthState
  // Caches mémoire (anciennement champs d'instance) :
  lidToPn: Map<string, string>;
  blockedJids: Set<string>;
  historySyncing: boolean;
  groupBackfillRunning: boolean;
  groupBackfillAt: number;
  avatarInflight: Map<string, Promise<{ buffer: Buffer; mimetype: string }>>;
  avatarNoPhoto: Map<string, number>;
  avatarActive: number;
  avatarQueue: Array<() => void>;
  localMetaGuard: Map<string, { archivedUntil: number; mutedUntil: number }>;
}

@Injectable()
export class WhatsappService
  extends EventEmitter
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WhatsappService.name);
  private readonly waLogger = pino({ level: 'warn' });
  // Emplacements historiques (mono-compte). Le compte 'default' est mappé
  // EXACTEMENT sur ces racines (cf. authDirFor/mediaDirFor) pour ne pas
  // invalider la session live ni perdre les caches média/avatar.
  private baseAuthDir = '/data/wa-auth';
  private baseMediaDir = '/data/media-cache';
  // État runtime par compte. En Phase 1, une seule clé: 'default'.
  private readonly sessions = new Map<string, AccountSession>();
  // Comptes supprimés dans ce process: empêche toute reconnexion "zombie"
  // déclenchée par un événement Baileys tardif (close/loggedOut) après purge.
  // Les ids étant des UUID, ils ne sont jamais réutilisés -> tombstone durable.
  private readonly removedAccounts = new Set<string>();

  private static readonly LOCAL_META_GUARD_MS = 20_000;
  private static readonly AVATAR_MAX_CONCURRENT = 3;
  // 24 h: une entrée "pas de photo" mise à tort (timeout) se répare en 1 jour.
  private static readonly AVATAR_NEG_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
  private static readonly AVATAR_TIMEOUT_MS = 10000;
  // Borne sur les mutations app-state (mute/archive) qui peuvent ne pas répondre.
  private static readonly CHATMODIFY_TIMEOUT_MS = 8000;
  // Bornes sur les opérations de blocage / statut (peuvent ne pas répondre).
  private static readonly BLOCKLIST_TIMEOUT_MS = 10000;
  private static readonly BLOCK_TIMEOUT_MS = 8000;
  private static readonly STATUS_TIMEOUT_MS = 8000;
  // Types de message porteurs d'un média (galerie « Médias, liens et documents »).
  private static readonly MEDIA_TYPES: readonly WaMessageType[] = [
    WaMessageType.IMAGE,
    WaMessageType.VIDEO,
    WaMessageType.AUDIO,
    WaMessageType.DOCUMENT,
    WaMessageType.STICKER,
  ];
  // Plafond de la galerie média (récents d'abord) — borne la requête/réponse.
  private static readonly MEDIA_GALLERY_LIMIT = 200;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super();
    this.setMaxListeners(50);
  }

  async onModuleInit(): Promise<void> {
    this.baseAuthDir = this.config.get<string>('waAuthDir') ?? this.baseAuthDir;
    this.baseMediaDir =
      this.config.get<string>('waMediaDir') ?? this.baseMediaDir;
    // Garantit la présence du compte historique même hors migration.
    await this.prisma.waAccount
      .upsert({
        where: { id: DEFAULT_ACCOUNT_ID },
        create: {
          id: DEFAULT_ACCOUNT_ID,
          label: 'Compte principal',
          isDefault: true,
          sortOrder: 0,
        },
        update: {},
      })
      .catch((e) => this.logger.warn(`seed compte default: ${e}`));
    await this.loadLidMap(DEFAULT_ACCOUNT_ID);
    await this.connect(DEFAULT_ACCOUNT_ID);

    // Reconnecte les comptes secondaires déjà liés (hors 'default', déjà lancé,
    // et hors ceux explicitement déliés -> status 'logged_out'). Non bloquant.
    const others = await this.prisma.waAccount
      .findMany({ where: { id: { not: DEFAULT_ACCOUNT_ID } } })
      .catch(() => []);
    for (const acc of others) {
      if ((acc.status as ConnectionState) === ConnectionState.LOGGED_OUT) {
        continue;
      }
      await this.loadLidMap(acc.id);
      void this.connect(acc.id);
    }
  }

  onModuleDestroy(): void {
    for (const s of this.sessions.values()) {
      s.destroyed = true;
      try {
        s.sock?.end(undefined);
      } catch {
        /* noop */
      }
    }
  }

  // Dossier auth Baileys d'un compte. Le 'default' pointe sur la RACINE
  // historique (pas de sous-dossier) -> session live préservée.
  private authDirFor(accountId: string): string {
    return accountId === DEFAULT_ACCOUNT_ID
      ? this.baseAuthDir
      : join(this.baseAuthDir, accountId);
  }

  // Dossier cache média/avatar d'un compte. Le 'default' pointe sur la RACINE
  // historique -> cache média/avatar intact.
  private mediaDirFor(accountId: string): string {
    return accountId === DEFAULT_ACCOUNT_ID
      ? this.baseMediaDir
      : join(this.baseMediaDir, accountId);
  }

  // Get-or-create idempotent de la session d'un compte (caches vides au départ).
  private ensureSession(accountId = DEFAULT_ACCOUNT_ID): AccountSession {
    let s = this.sessions.get(accountId);
    if (!s) {
      s = {
        accountId,
        sock: null,
        authDir: this.authDirFor(accountId),
        mediaDir: this.mediaDirFor(accountId),
        connecting: false,
        destroyed: false,
        connection: {
          accountId,
          state: ConnectionState.CONNECTING,
          qr: null,
          me: null,
        },
        lidToPn: new Map(),
        blockedJids: new Set(),
        historySyncing: false,
        groupBackfillRunning: false,
        groupBackfillAt: 0,
        avatarInflight: new Map(),
        avatarNoPhoto: new Map(),
        avatarActive: 0,
        avatarQueue: [],
        localMetaGuard: new Map(),
      };
      this.sessions.set(accountId, s);
    }
    return s;
  }

  // Vrai SI la session porte un cycle de connexion RÉEL (socket créé, ou
  // connexion en cours), par opposition à une session FANTÔME fabriquée par
  // ensureSession depuis un chemin de LECTURE (listChats/chatRowToDto, markRead…)
  // pour un compte sans connexion: celle-ci a sock=null & connecting=false et son
  // connection.state 'connecting' ne doit JAMAIS écraser le vrai statut DB.
  private isLiveSession(s: AccountSession): boolean {
    return s.sock !== null || s.connecting;
  }

  // Connexion live d'un compte SANS créer de session (lecture seule). Renvoie
  // null si aucune session RÉELLE n'existe (compte délié / non reconnecté au
  // boot, ou session fantôme issue d'un chemin de lecture).
  peekConnection(accountId: string): WaConnection | null {
    const s = this.sessions.get(accountId);
    return s && this.isLiveSession(s) ? s.connection : null;
  }

  // Connexion d'un compte. NON MUTANT: ne crée PAS de session fantôme pour un
  // compte sans session live (sinon on écraserait un vrai statut 'logged_out'
  // stocké par un placeholder 'connecting'). Repli sur un DTO 'connecting'.
  getConnection(accountId = DEFAULT_ACCOUNT_ID): WaConnection {
    return (
      this.peekConnection(accountId) ?? {
        accountId,
        state: ConnectionState.CONNECTING,
        qr: null,
        me: null,
      }
    );
  }

  private setConnection(
    accountId: string,
    patch: Partial<WaConnection>,
  ): void {
    const s = this.ensureSession(accountId);
    const prev = s.connection;
    s.connection = { ...prev, ...patch, accountId };
    this.emit('connection', accountId, s.connection);
    // Persiste l'état "durable" (status + phoneJid) sur les transitions utiles
    // pour survivre au redémarrage et piloter la reconnexion au boot. On ignore
    // les états transitoires QR/CONNECTING (le QR ne se persiste pas). Le 'default'
    // reste toujours reconnecté au boot: pas besoin de persister son status.
    if (
      accountId !== DEFAULT_ACCOUNT_ID &&
      s.connection.state !== prev.state &&
      s.connection.state !== ConnectionState.QR &&
      s.connection.state !== ConnectionState.CONNECTING
    ) {
      const phoneJid = s.connection.me?.jid ?? null;
      void this.prisma.waAccount
        .update({
          where: { id: accountId },
          data: {
            status: s.connection.state,
            ...(phoneJid ? { phoneJid } : {}),
          },
        })
        .catch(() => undefined);
    }
  }

  // Liste des comptes du pont (REST GET /wa/accounts). Le 'default' reflète
  // l'état live de sa session (status/phoneJid), les autres l'état stocké.
  async listAccounts(): Promise<WaAccountsResponse> {
    const rows = await this.prisma.waAccount
      .findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })
      .catch(() => []);
    const accounts: WaAccount[] = rows.map((r) => {
      const s = this.sessions.get(r.id);
      // On ne fait confiance à la session QUE si elle est réelle (isLiveSession):
      // une session fantôme (chemin de lecture) ne doit pas écraser le statut DB.
      const live = s && this.isLiveSession(s) ? s : null;
      const status = live
        ? live.connection.state
        : (r.status as ConnectionState);
      const phoneJid = live?.connection.me?.jid ?? r.phoneJid ?? null;
      return {
        id: r.id,
        label: r.label,
        color: r.color,
        phoneJid,
        status,
        isDefault: r.isDefault,
        sortOrder: r.sortOrder,
      };
    });
    return { accounts, defaultAccountId: DEFAULT_ACCOUNT_ID };
  }

  // Diffuse la liste des comptes à jour (après create/delete/rename).
  private async emitAccounts(): Promise<void> {
    this.emit('accounts', await this.listAccounts());
  }

  // Crée un nouveau compte et lance sa connexion (un QR sera émis via
  // 'wa:connection' pour l'id renvoyé). Le label est nettoyé; couleur optionnelle.
  async createAccount(label: string, color?: string): Promise<WaAccount> {
    const cleanLabel = cleanName(label) ?? 'Nouveau compte';
    // id court, stable et sûr comme nom de sous-dossier (auth/media).
    const id = `acc_${randomUUID().slice(0, 8)}`;
    const agg = await this.prisma.waAccount
      .aggregate({ _max: { sortOrder: true } })
      .catch(() => null);
    const sortOrder = (agg?._max.sortOrder ?? 0) + 1;
    const row = await this.prisma.waAccount.create({
      data: {
        id,
        label: cleanLabel,
        color: color ?? null,
        status: ConnectionState.CONNECTING,
        isDefault: false,
        sortOrder,
      },
    });
    // Prépare la session + démarre la connexion (émettra le QR).
    await this.loadLidMap(id);
    void this.connect(id);
    await this.emitAccounts();
    return {
      id: row.id,
      label: row.label,
      color: row.color,
      phoneJid: null,
      status: ConnectionState.CONNECTING,
      isDefault: false,
      sortOrder: row.sortOrder,
    };
  }

  // (Re)lance la connexion d'un compte existant (ex: régénérer un QR).
  async connectAccount(accountId = DEFAULT_ACCOUNT_ID): Promise<void> {
    const s = this.ensureSession(accountId);
    s.destroyed = false;
    await this.connect(accountId);
  }

  // Renomme / recolore un compte (couleur mise à jour seulement si fournie).
  async renameAccount(
    accountId: string,
    label?: string,
    color?: string,
  ): Promise<void> {
    const data: Prisma.WaAccountUpdateInput = {};
    const cleanLabel = cleanName(label);
    if (cleanLabel) data.label = cleanLabel;
    if (color !== undefined) data.color = color || null;
    if (Object.keys(data).length === 0) return;
    await this.prisma.waAccount
      .update({ where: { id: accountId }, data })
      .catch((e) => this.logger.warn(`renameAccount ${accountId}: ${e}`));
    await this.emitAccounts();
  }

  // Valide un id de compte destiné à une opération DESTRUCTIVE. Rejette le
  // compte principal et tout id non conforme (vide, '.', '..', séparateurs de
  // chemin…) pour empêcher toute traversée vers la racine partagée. Les ids
  // générés sont de la forme `acc_<hex>` -> ce motif les couvre.
  private assertDeletableAccountId(accountId: string): void {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      throw new Error('Le compte principal ne peut pas être supprimé.');
    }
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(accountId)) {
      throw new Error('Identifiant de compte invalide.');
    }
  }

  // Défense en profondeur: garantit que `dir` est STRICTEMENT sous `base`
  // (jamais la racine elle-même), avant tout rm récursif.
  private assertUnderBase(dir: string, base: string): void {
    const rel = relative(base, dir);
    if (!rel || rel === '..' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Chemin de compte hors du dossier autorisé.');
    }
  }

  // Déliaison best-effort bornée dans le temps (logout() peut ne jamais répondre
  // si le socket est déjà mort) -> ne bloque pas la suppression / l'ACK client.
  private async safeLogout(s: AccountSession): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 4000);
      // Ne pas retenir l'event loop si logout() gagne la course (arrêt gracieux).
      timer.unref?.();
    });
    try {
      await Promise.race([s.sock?.logout() ?? Promise.resolve(), guard]);
    } catch {
      /* déjà hors ligne */
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Supprime un compte: purge des données scopées + dossiers auth/média, puis
  // déliaison. Interdit sur 'default'. La transaction DB est le POINT DE COMMIT:
  // si elle échoue, on lève (rien de destructif n'a eu lieu) -> l'ACK renvoie
  // ok:false et l'état reste cohérent.
  async deleteAccount(accountId: string): Promise<void> {
    this.assertDeletableAccountId(accountId);
    const exists = await this.prisma.waAccount.findUnique({
      where: { id: accountId },
    });
    if (!exists) {
      throw new Error('Compte introuvable.');
    }
    const authDir = this.authDirFor(accountId);
    const mediaDir = this.mediaDirFor(accountId);
    this.assertUnderBase(authDir, this.baseAuthDir);
    this.assertUnderBase(mediaDir, this.baseMediaDir);

    // 1) Purge DB atomique. Si elle échoue, on PROPAGE (pas de .catch): aucune
    //    session n'a été fermée et aucun dossier supprimé -> état intact.
    await this.prisma.$transaction([
      this.prisma.waMessage.deleteMany({ where: { accountId } }),
      this.prisma.waChat.deleteMany({ where: { accountId } }),
      this.prisma.waContact.deleteMany({ where: { accountId } }),
      this.prisma.waLidMap.deleteMany({ where: { accountId } }),
      this.prisma.waAccount.delete({ where: { id: accountId } }),
    ]);

    // 2) Point de commit franchi: nettoyage best-effort (session + dossiers).
    //    Tombstone AVANT teardown: un événement Baileys tardif ne peut plus
    //    relancer la connexion (cf. garde dans connect()).
    this.removedAccounts.add(accountId);
    const s = this.sessions.get(accountId);
    if (s) {
      s.destroyed = true;
      await this.safeLogout(s);
      try {
        s.sock?.end(undefined);
      } catch {
        /* noop */
      }
      this.sessions.delete(accountId);
    }
    // Dossiers auth/média du compte (sous-dossiers dédiés, jamais la racine).
    await rm(authDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(mediaDir, { recursive: true, force: true }).catch(() => undefined);
    await this.emitAccounts();
  }

  // --- Connexion / cycle de vie ---

  private async connect(accountId = DEFAULT_ACCOUNT_ID): Promise<void> {
    // Compte supprimé: ne jamais (re)connecter (garde anti-zombie).
    if (this.removedAccounts.has(accountId)) return;
    const s = this.ensureSession(accountId);
    if (s.connecting || s.destroyed) return;
    s.connecting = true;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(s.authDir);
      s.saveCreds = saveCreds;

      let version: [number, number, number] | undefined;
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch {
        this.logger.warn('fetchLatestBaileysVersion a échoué, version par défaut');
      }

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          keys: makeCacheableSignalKeyStore(state.keys, this.waLogger as any),
        },
        printQRInTerminal: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: this.waLogger as any,
        browser: ['wa-bridge', 'Chrome', '1.0.0'],
        syncFullHistory: true,
        markOnlineOnConnect: false,
        getMessage: async () => undefined,
      });
      s.sock = sock;

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (u) => {
        void this.onConnectionUpdate(accountId, u);
      });
      sock.ev.on('messages.upsert', (u) => {
        void this.onMessagesUpsert(accountId, u).catch((e) =>
          this.logger.error(`messages.upsert: ${e}`),
        );
      });
      sock.ev.on('messages.update', (updates) => {
        void this.onMessagesUpdate(accountId, updates).catch((e) =>
          this.logger.error(`messages.update: ${e}`),
        );
      });
      // Accusés de réception/lecture de NOS messages envoyés.
      sock.ev.on('message-receipt.update', (updates) => {
        void this.onReceiptUpdate(accountId, updates).catch((e) =>
          this.logger.error(`message-receipt.update: ${e}`),
        );
      });
      sock.ev.on('messaging-history.set', (h) => {
        void this.onHistorySet(accountId, h).catch((e) =>
          this.logger.error(`history.set: ${e}`),
        );
      });
      sock.ev.on('chats.upsert', (chats) => {
        void this.onChatsUpsert(accountId, chats).catch((e) =>
          this.logger.error(`chats.upsert: ${e}`),
        );
      });
      // Mise à jour de discussions (ex: non-lus remis à 0 quand tu lis sur le tél).
      sock.ev.on('chats.update', (updates) => {
        void this.onChatsUpdate(accountId, updates).catch((e) =>
          this.logger.error(`chats.update: ${e}`),
        );
      });
      sock.ev.on('contacts.upsert', (contacts) => {
        void this.onContactsUpsert(accountId, contacts).catch((e) =>
          this.logger.error(`contacts.upsert: ${e}`),
        );
      });
      // Sujets de groupe (création / renommage) -> nom de la discussion.
      sock.ev.on('groups.upsert', (groups) => {
        void this.onGroupsUpsert(accountId, groups).catch((e) =>
          this.logger.error(`groups.upsert: ${e}`),
        );
      });
      sock.ev.on('groups.update', (updates) => {
        void this.onGroupsUpsert(accountId, updates).catch((e) =>
          this.logger.error(`groups.update: ${e}`),
        );
      });
      // Présence entrante ("en ligne" / "en train d'écrire").
      sock.ev.on('presence.update', (u) => {
        void this.onPresence(accountId, u).catch((e) =>
          this.logger.error(`presence.update: ${e}`),
        );
      });
      // Liste des contacts bloqués: snapshot complet (set) ou delta (update).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sock.ev.on('blocklist.set', (u: any) => {
        void this.onBlocklistSet(
          accountId,
          (u?.blocklist ?? []) as string[],
        ).catch((e) => this.logger.error(`blocklist.set: ${e}`));
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sock.ev.on('blocklist.update', (u: any) => {
        void this.onBlocklistUpdate(
          accountId,
          (u?.blocklist ?? []) as string[],
          (u?.type ?? 'add') as 'add' | 'remove',
        ).catch((e) => this.logger.error(`blocklist.update: ${e}`));
      });
    } finally {
      s.connecting = false;
    }
  }

  private async onConnectionUpdate(
    accountId: string,
    u: Partial<BaileysConnectionState>,
  ): Promise<void> {
    const s = this.ensureSession(accountId);
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      this.setConnection(accountId, { state: ConnectionState.QR, qr, me: null });
    }

    if (connection === 'open') {
      const me = s.sock?.user;
      this.setConnection(accountId, {
        state: ConnectionState.OPEN,
        qr: null,
        me: me
          ? { jid: jidNormalizedUser(me.id), name: me.name ?? null }
          : null,
      });
      this.logger.log('WhatsApp connecté');
      void this.backfillGroupSubjects(accountId);
      void this.syncBlocklist(accountId);
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output
        ?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        this.logger.warn('Session WhatsApp déconnectée (logged out)');
        this.setConnection(accountId, {
          state: ConnectionState.LOGGED_OUT,
          qr: null,
          me: null,
        });
        await this.clearAuth(accountId);
      } else {
        this.setConnection(accountId, { state: ConnectionState.CLOSE, qr: null });
      }
      // Reconnexion (sauf si on a été détruit)
      if (!s.destroyed) {
        setTimeout(() => void this.connect(accountId), 2000);
      }
    }
  }

  private async clearAuth(accountId: string): Promise<void> {
    const s = this.ensureSession(accountId);
    // On efface le CONTENU du dossier (pas le dossier lui-même: c'est un point
    // de montage de volume -> rm sur la racine échoue EBUSY et laisse la session
    // révoquée en place, ce qui provoque une boucle de "logged out").
    // Le compte 'default' pointe sur la RACINE partagée /data/wa-auth: les autres
    // comptes y vivent dans des SOUS-DOSSIERS. On ne touche donc qu'aux fichiers
    // (l'auth Baileys est plate: creds.json, session-*.json...) pour ne pas
    // effacer les sessions des autres comptes en déconnectant le principal.
    const skipDirs = accountId === DEFAULT_ACCOUNT_ID;
    try {
      const entries = await readdir(s.authDir, { withFileTypes: true }).catch(
        () => [],
      );
      await Promise.all(
        entries
          .filter((e) => !(skipDirs && e.isDirectory()))
          .map((e) =>
            rm(join(s.authDir, e.name), { recursive: true, force: true }),
          ),
      );
    } catch (e) {
      this.logger.error(`clearAuth: ${e}`);
    }
  }

  async logout(accountId = DEFAULT_ACCOUNT_ID): Promise<void> {
    const s = this.ensureSession(accountId);
    try {
      await s.sock?.logout();
    } catch {
      /* noop */
    }
    await this.clearAuth(accountId);
    this.setConnection(accountId, {
      state: ConnectionState.LOGGED_OUT,
      qr: null,
      me: null,
    });
    if (!s.destroyed) setTimeout(() => void this.connect(accountId), 1000);
  }

  // --- Réception ---

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onMessagesUpsert(accountId: string, u: any): Promise<void> {
    const s = this.ensureSession(accountId);
    const messages = (u?.messages ?? []) as proto.IWebMessageInfo[];
    for (const raw of messages) {
      // Apprend la correspondance LID->numéro portée par la clé (et fusionne).
      await this.learnFromKey(accountId, raw.key);
      // Une réaction met à jour le message CIBLE, ne crée pas de bulle.
      if (raw.message?.reactionMessage) {
        await this.handleReaction(accountId, raw);
        continue;
      }
      // Suppression "pour tout le monde" (revoke) ou édition: portées par un
      // protocolMessage ciblant un autre message. Traité AVANT le mapping (qui
      // renverrait null pour un protocolMessage) -> placeholder / upsert front.
      if (await this.handleProtocolMessage(accountId, raw)) continue;
      const msg = mapWaMessage(raw, s.sock?.user?.id, accountId);
      if (!msg) continue;
      // Ignore les Status/Stories et newsletters (pas des conversations).
      if (this.isIgnoredChat(msg.chatJid)) continue;
      // Canonicalise vers le numéro pour qu'un contact = UNE conversation.
      msg.chatJid = (await this.resolvePn(accountId, msg.chatJid)) ?? msg.chatJid;
      msg.senderJid = await this.resolvePn(accountId, msg.senderJid);
      // Média: extrait le SHA-256 du fichier + conserve le message brut.
      const { rawContent, fileSha256 } = msg.media
        ? this.mediaInfoOf(raw.message)
        : { rawContent: null, fileSha256: null };
      // Dédup double livraison LID: même fichier déjà reçu (id différent) -> on ignore.
      if (
        msg.media &&
        fileSha256 &&
        (await this.isDuplicateMedia(accountId, msg, fileSha256))
      ) {
        continue;
      }
      await this.persistMessage(
        accountId,
        msg,
        msg.media ? { rawMessage: rawContent, fileSha256 } : undefined,
      );
      this.attachMediaUrl(msg);
      const chat = await this.touchChat(accountId, msg);
      this.emit('message', accountId, msg);
      if (chat) this.emit('chat-upsert', accountId, chat);
    }
  }

  // Traite une réaction emoji: met à jour les réactions du message CIBLE.
  // Frontière Baileys -> typage borné à any.
  private async handleReaction(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: any,
  ): Promise<void> {
    const s = this.ensureSession(accountId);
    try {
      const rm = raw.message.reactionMessage;
      const target = rm?.key;
      if (!target?.id || !target?.remoteJid) return;
      const targetId: string = target.id;
      const chatJid =
        (await this.resolvePn(accountId, target.remoteJid)) ?? target.remoteJid;
      const emoji: string = (rm.text ?? '').trim(); // '' => retrait
      const fromMe = Boolean(raw.key?.fromMe);
      let senderJid: string | null = fromMe
        ? s.sock?.user?.id
          ? jidNormalizedUser(s.sock.user.id)
          : null
        : (raw.key?.participant ?? raw.key?.remoteJid ?? null);
      senderJid = await this.resolvePn(accountId, senderJid);

      // Charge le message cible (on ne réagit pas à un message inconnu).
      const msg = await this.prisma.waMessage
        .findUnique({
          where: { accountId_chatJid_id: { accountId, chatJid, id: targetId } },
        })
        .catch(() => null);
      if (!msg) return;

      const current = (msg.reactions as WaReaction[] | null) ?? [];
      // Retire la réaction existante du même auteur (clé = senderJid si connu,
      // sinon fromMe).
      const reactions = current.filter((r) =>
        senderJid !== null ? r.senderJid !== senderJid : r.fromMe !== fromMe,
      );
      if (emoji) reactions.push({ emoji, senderJid, fromMe });

      await this.prisma.waMessage
        .update({
          where: { accountId_chatJid_id: { accountId, chatJid, id: targetId } },
          data: { reactions: reactions as unknown as Prisma.InputJsonValue },
        })
        .catch(() => undefined);

      this.emit('reaction', accountId, {
        chatJid,
        messageId: targetId,
        reactions,
      });
    } catch (e) {
      this.logger.error(`handleReaction: ${e}`);
    }
  }

  // Suppression (revoke) / édition d'un message: un protocolMessage CIBLE un
  // autre message via protocolMessage.key. Retourne true si l'événement a été
  // consommé (ne PAS créer de bulle). Frontière Baileys -> typage borné à any.
  private async handleProtocolMessage(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: any,
  ): Promise<boolean> {
    try {
      // Déballe les enveloppes (ephemeral, editedMessage, ...) pour atteindre
      // le protocolMessage éventuel.
      const content = raw?.message
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (normalizeMessageContent(raw.message) as any)
        : null;
      const protocol = content?.protocolMessage;
      if (!protocol?.key?.id || protocol.type == null) return false;

      const Type = proto.Message.ProtocolMessage.Type;
      const targetId: string = protocol.key.id;
      const rawJid: string | null =
        protocol.key.remoteJid ?? raw.key?.remoteJid ?? null;
      if (!rawJid) return false;
      const chatJid = (await this.resolvePn(accountId, rawJid)) ?? rawJid;

      if (protocol.type === Type.REVOKE) {
        await this.applyRevoke(accountId, chatJid, targetId);
        return true;
      }
      if (protocol.type === Type.MESSAGE_EDIT) {
        const newText = this.extractEditedText(protocol.editedMessage);
        if (newText !== null)
          await this.applyEdit(accountId, chatJid, targetId, newText);
        // Consommé même si le texte n'a pu être extrait (pas de bulle de contrôle).
        return true;
      }
      return false;
    } catch (e) {
      this.logger.error(`handleProtocolMessage: ${e}`);
      return false;
    }
  }

  // Marque le message cible comme supprimé (placeholder façon WhatsApp) et
  // réémet le message: le front le remplace via upsert(id).
  private async applyRevoke(
    accountId: string,
    chatJid: string,
    targetId: string,
  ): Promise<void> {
    const row = await this.prisma.waMessage
      .update({
        where: { accountId_chatJid_id: { accountId, chatJid, id: targetId } },
        data: {
          text: '🚫 Ce message a été supprimé',
          type: 'system',
          media: Prisma.DbNull,
        },
      })
      .catch(() => null); // message cible inconnu -> on ignore
    if (row) this.emit('message', accountId, this.msgRowToDto(accountId, row));
  }

  // Applique l'édition d'un message (nouveau texte) puis réémet pour upsert front.
  private async applyEdit(
    accountId: string,
    chatJid: string,
    targetId: string,
    text: string,
  ): Promise<void> {
    const row = await this.prisma.waMessage
      .update({
        where: { accountId_chatJid_id: { accountId, chatJid, id: targetId } },
        data: { text, editedAt: new Date() },
      })
      .catch(() => null);
    if (row) this.emit('message', accountId, this.msgRowToDto(accountId, row));
  }

  // Extrait le nouveau texte d'un contenu édité (proto.IMessage).
  // Frontière Baileys -> typage borné à any.
  private extractEditedText(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    edited: any,
  ): string | null {
    try {
      if (!edited) return null;
      const c =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (normalizeMessageContent(edited) as any) ?? edited;
      const text =
        c?.conversation ??
        c?.extendedTextMessage?.text ??
        c?.imageMessage?.caption ??
        c?.videoMessage?.caption ??
        c?.documentMessage?.caption ??
        null;
      return typeof text === 'string' ? text : null;
    } catch {
      return null;
    }
  }

  private async onMessagesUpdate(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updates: any[],
  ): Promise<void> {
    for (const { key, update } of updates) {
      const rawJid: string | undefined = key?.remoteJid ?? undefined;
      const id: string | undefined = key?.id ?? undefined;
      if (!rawJid || !id) continue;
      if (update.status === undefined || update.status === null) continue;
      // Le message est stocké sous le JID canonique (téléphone) ; l'accusé peut
      // arriver sous le JID @lid -> on canonicalise pour retrouver le message.
      const chatJid = (await this.resolvePn(accountId, rawJid)) ?? rawJid;
      const status = this.mapNumericStatus(update.status);
      await this.prisma.waMessage
        .update({
          where: { accountId_chatJid_id: { accountId, chatJid, id } },
          data: { status },
        })
        .catch(() => undefined); // message pas encore en cache
      this.emit('message-status', accountId, { id, chatJid, status });

      // En 1:1, distribution/lecture arrivent ICI (statut agrégé) et NON via
      // message-receipt.update — donc sans horodatage par destinataire. On
      // enregistre alors l'accusé pour le destinataire (= le chat) horodaté à
      // l'instant de réception (proxy précis à ~1-2 s), pour « Infos du
      // message ». En groupe, message-receipt.update (par participant, horodaté)
      // fait foi -> on ne double-compte pas ici.
      if (!isJidGroup(chatJid)) {
        const now = Date.now();
        const stamp =
          status === WaMessageStatus.PLAYED
            ? { deliveredAt: null, readAt: null, playedAt: now }
            : status === WaMessageStatus.READ
              ? { deliveredAt: null, readAt: now, playedAt: null }
              : status === WaMessageStatus.DELIVERED
                ? { deliveredAt: now, readAt: null, playedAt: null }
                : null;
        if (stamp) await this.mergeReceipt(accountId, chatJid, id, chatJid, stamp);
      }
    }
  }

  private mapNumericStatus(status: number): WaMessageStatus {
    switch (status) {
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

  // Accusés (delivered/read/played) de nos messages envoyés.
  private async onReceiptUpdate(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updates: any[],
  ): Promise<void> {
    // Convertit un timestamp proto (SECONDES Unix, parfois objet Long) en epoch ms.
    const toMs = (t: unknown): number | null => {
      if (t == null) return null;
      const n =
        typeof t === 'number'
          ? t
          : Number((t as { toNumber?: () => number }).toNumber?.() ?? t);
      return Number.isFinite(n) && n > 0 ? n * 1000 : null;
    };
    for (const { key, receipt } of updates) {
      const rawJid: string | undefined = key?.remoteJid ?? undefined;
      const id: string | undefined = key?.id ?? undefined;
      if (!rawJid || !id || !receipt) continue;
      let status: WaMessageStatus | null = null;
      if (receipt.playedTimestamp) status = WaMessageStatus.PLAYED;
      else if (receipt.readTimestamp) status = WaMessageStatus.READ;
      else if (receipt.receiptTimestamp) status = WaMessageStatus.DELIVERED;
      if (!status) continue;
      // L'accusé peut arriver sous le JID @lid alors que le message est stocké
      // sous le JID canonique (téléphone) -> on canonicalise.
      const chatJid = (await this.resolvePn(accountId, rawJid)) ?? rawJid;
      await this.prisma.waMessage
        .update({
          where: { accountId_chatJid_id: { accountId, chatJid, id } },
          data: { status },
        })
        .catch(() => undefined);
      this.emit('message-status', accountId, { id, chatJid, status });

      // Capture l'accusé PAR destinataire (panneau « Infos du message »).
      // userJid identifie le destinataire (présent surtout en groupe).
      const userJid =
        (await this.resolvePn(accountId, receipt.userJid)) ?? receipt.userJid;
      if (userJid) {
        await this.mergeReceipt(accountId, chatJid, id, userJid, {
          deliveredAt: toMs(receipt.receiptTimestamp),
          readAt: toMs(receipt.readTimestamp),
          playedAt: toMs(receipt.playedTimestamp),
        });
      }
    }
  }

  // Fusionne un accusé par destinataire dans la colonne JSON `receipts`.
  // Les timestamps ne régressent jamais : on garde max(existant, nouveau).
  private async mergeReceipt(
    accountId: string,
    chatJid: string,
    id: string,
    userJid: string,
    next: {
      deliveredAt: number | null;
      readAt: number | null;
      playedAt: number | null;
    },
  ): Promise<void> {
    const row = await this.prisma.waMessage
      .findUnique({
        where: { accountId_chatJid_id: { accountId, chatJid, id } },
        select: { receipts: true, fromMe: true },
      })
      .catch(() => null);
    // Accusés seulement pour NOS messages sortants (pas pour les entrants).
    if (!row || !row.fromMe) return;
    const list = (row.receipts as WaMessageReceipt[] | null) ?? [];
    const max = (a: number | null, b: number | null): number | null =>
      a != null && b != null ? Math.max(a, b) : (a ?? b ?? null);
    const existing = list.find((r) => r.userJid === userJid);
    if (existing) {
      existing.deliveredAt = max(existing.deliveredAt, next.deliveredAt);
      existing.readAt = max(existing.readAt, next.readAt);
      existing.playedAt = max(existing.playedAt, next.playedAt);
    } else {
      // name résolu à la lecture (getMessageInfo) -> stocké à null.
      list.push({ userJid, name: null, ...next });
    }
    await this.prisma.waMessage
      .update({
        where: { accountId_chatJid_id: { accountId, chatJid, id } },
        data: { receipts: list as unknown as Prisma.InputJsonValue },
      })
      .catch(() => undefined);
  }

  // Types Baileys volatils selon la version -> on borne le typage à la frontière.
  private async onHistorySet(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h: any,
  ): Promise<void> {
    const s = this.ensureSession(accountId);
    // Contacts: name = carnet d'adresses (ce que TU as enregistré), pushName =
    // ce que le contact s'est donné. On découple strictement (cf. onContactsUpsert).
    for (const c of h.contacts ?? []) {
      await this.upsertContact(accountId, c);
    }

    // Chats
    for (const ch of h.chats ?? []) {
      if (this.isIgnoredChat(ch.id)) continue;
      // Normalise le suffixe d'appareil (:0) pour éviter les doublons.
      const jid = this.normJid(ch.id);
      const ts = ch.conversationTimestamp;
      const lastAt =
        ts == null
          ? null
          : new Date(
              (typeof ts === 'number' ? ts : ts.toNumber()) * 1000,
            );
      const name = await this.chatDisplayName(accountId, jid, ch.name);
      // Archive/mute portés par l'historique (app-state) — sinon on les perdait.
      const meta = this.chatMetaOf(ch);
      await this.prisma.waChat
        .upsert({
          where: { accountId_jid: { accountId, jid } },
          create: {
            accountId,
            jid,
            name,
            isGroup: isJidGroup(jid) ?? false,
            unreadCount: ch.unreadCount ?? 0,
            lastMessageAt: lastAt,
            ...(meta.archived !== undefined ? { archived: meta.archived } : {}),
            ...(meta.muted !== undefined ? { muted: meta.muted } : {}),
          },
          update: {
            name: name ?? undefined,
            unreadCount: ch.unreadCount ?? undefined,
            lastMessageAt: lastAt ?? undefined,
            ...(meta.archived !== undefined ? { archived: meta.archived } : {}),
            ...(meta.muted !== undefined ? { muted: meta.muted } : {}),
          },
        })
        .catch(() => undefined);
    }

    // Messages (par lots, dédupliqués). On conserve le couple (brut, mappé)
    // pour pouvoir extraire le média (SHA-256 + message brut) au moment voulu.
    const rawMessages = (h.messages ?? []) as proto.IWebMessageInfo[];
    const pairs = rawMessages
      .map((raw) => ({ raw, msg: mapWaMessage(raw, s.sock?.user?.id, accountId) }))
      .filter(
        (p): p is { raw: proto.IWebMessageInfo; msg: WaMessage } =>
          p.msg !== null,
      )
      .filter((p) => !this.isIgnoredChat(p.msg.chatJid));

    // Résout (une seule fois) chaque LID distinct du lot via l'API native 7.x,
    // ce qui peuple le cache lidToPn. On évite le flot d'emit pendant la synchro.
    s.historySyncing = true;
    const lids = new Set<string>();
    for (const { msg } of pairs) {
      if (msg.chatJid && isLidUser(msg.chatJid)) lids.add(msg.chatJid);
      if (msg.senderJid && isLidUser(msg.senderJid)) lids.add(msg.senderJid);
    }
    for (const lid of lids) await this.resolvePn(accountId, lid);
    s.historySyncing = false;

    // Canonicalise via le cache (synchrone) avant insertion + dédup média.
    const seenSha = new Set<string>(); // doublons LID au sein du même lot
    const rows: Prisma.WaMessageCreateManyInput[] = [];
    for (const { raw, msg } of pairs) {
      msg.chatJid = this.canonicalJid(accountId, msg.chatJid) ?? msg.chatJid;
      msg.senderJid = this.canonicalJid(accountId, msg.senderJid);
      if (msg.media) {
        const { rawContent, fileSha256 } = this.mediaInfoOf(raw.message);
        if (fileSha256) {
          const key = `${msg.chatJid}|${fileSha256}`;
          if (seenSha.has(key)) continue; // doublon dans ce lot
          if (await this.isDuplicateMedia(accountId, msg, fileSha256)) continue; // déjà en DB
          seenSha.add(key);
        }
        rows.push(
          this.toMessageRow(accountId, msg, {
            rawMessage: rawContent,
            fileSha256,
          }),
        );
      } else {
        rows.push(this.toMessageRow(accountId, msg));
      }
    }
    for (let i = 0; i < rows.length; i += 500) {
      await this.prisma.waMessage
        .createMany({ data: rows.slice(i, i + 500), skipDuplicates: true })
        .catch(() => undefined);
    }

    const chats = await this.listChats(accountId);
    this.emit('chats', accountId, chats);
    this.emit('history-synced', accountId, { chatJid: null });
  }

  // Lit l'état archivé/mute porté par un objet chat Baileys (upsert ou update).
  // - ch.archived: boolean (présent seulement si l'info est fournie).
  // - ch.muteEndTime: timestamp ms (-1 = indéfini, null/0 = non mute).
  // Retourne des champs `undefined` quand l'info n'est pas présente (=> on ne
  // touche pas la colonne correspondante).
  // Frontière Baileys -> typage borné à any.
  private chatMetaOf(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ch: any,
  ): { archived: boolean | undefined; muted: boolean | undefined } {
    const archived =
      typeof ch?.archived === 'boolean' ? ch.archived : undefined;
    let muted: boolean | undefined;
    if (ch?.muteEndTime !== undefined) {
      const m = ch.muteEndTime;
      const ms = typeof m === 'number' ? m : m == null ? 0 : Number(m);
      // muteEndTime arrive sous deux formes selon la source:
      //  - timestamp absolu (ms epoch) lors d'une synchro/mute depuis le tel,
      //  - durée relative (ms) dans l'écho de notre propre chatModify (ex 8h).
      // -1 = muet indéfini ; 0/null = non muet.
      if (ms === 0 || Number.isNaN(ms)) muted = false;
      else if (ms === -1) muted = true;
      else if (ms < EPOCH_FLOOR_MS) muted = true; // durée relative => muet
      else muted = ms > Date.now(); // timestamp absolu => muet si futur
    }
    return { archived, muted };
  }

  private async onChatsUpsert(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chats: any[],
  ): Promise<void> {
    for (const ch of chats) {
      if (this.isIgnoredChat(ch.id)) continue;
      const name = await this.chatDisplayName(accountId, ch.id, ch.name);
      const meta = this.chatMetaOf(ch);
      const row = await this.prisma.waChat
        .upsert({
          where: { accountId_jid: { accountId, jid: ch.id } },
          create: {
            accountId,
            jid: ch.id,
            name,
            isGroup: isJidGroup(ch.id) ?? false,
            unreadCount: ch.unreadCount ?? 0,
            ...(meta.archived !== undefined ? { archived: meta.archived } : {}),
            ...(meta.muted !== undefined ? { muted: meta.muted } : {}),
          },
          update: {
            name: name ?? undefined,
            unreadCount: ch.unreadCount ?? undefined,
            ...(meta.archived !== undefined ? { archived: meta.archived } : {}),
            ...(meta.muted !== undefined ? { muted: meta.muted } : {}),
          },
        })
        .catch(() => null);
      if (row) this.emit('chat-upsert', accountId, this.chatRowToDto(accountId, row));
    }
  }

  // Mises à jour de discussions (non-lus, nom...). Sert notamment à refléter
  // dans le web le fait que tu as lu une conversation depuis ton téléphone.
  // Mises à jour de discussions. Le `unreadCount` de WhatsApp y est AUTORITAIRE
  // (reflète l'état multi-device, dont les lectures sur le téléphone).
  private async onChatsUpdate(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updates: any[],
  ): Promise<void> {
    for (const ch of updates) {
      if (!ch?.id || this.isIgnoredChat(ch.id)) continue;
      const hasUnread = typeof ch.unreadCount === 'number';
      const meta = this.chatMetaOf(ch);
      // Rien d'intéressant ici (ni non-lus, ni nom, ni archive/mute).
      if (
        !hasUnread &&
        !ch.name &&
        meta.archived === undefined &&
        meta.muted === undefined
      ) {
        continue;
      }
      const jid = (await this.resolvePn(accountId, ch.id)) ?? ch.id;
      const subject = cleanName(ch.name);
      // Si on vient de poser archive/mute localement, ignorer l'écho WhatsApp
      // (sinon il réécrase notre état avec une valeur parfois incohérente).
      if (
        meta.archived !== undefined &&
        this.isMetaGuarded(accountId, jid, 'archived')
      ) {
        meta.archived = undefined;
      }
      if (
        meta.muted !== undefined &&
        this.isMetaGuarded(accountId, jid, 'muted')
      ) {
        meta.muted = undefined;
      }
      if (
        !hasUnread &&
        !subject &&
        meta.archived === undefined &&
        meta.muted === undefined
      ) {
        continue; // plus rien à écrire après suppression de l'écho gardé
      }
      const unread = hasUnread ? Math.max(0, ch.unreadCount as number) : undefined;
      const name = await this.chatDisplayName(accountId, jid, ch.name);
      const row = await this.prisma.waChat
        .upsert({
          where: { accountId_jid: { accountId, jid } },
          create: {
            accountId,
            jid,
            name,
            isGroup: isJidGroup(jid) ?? false,
            unreadCount: unread ?? 0,
            ...(meta.archived !== undefined ? { archived: meta.archived } : {}),
            ...(meta.muted !== undefined ? { muted: meta.muted } : {}),
          },
          update: {
            ...(unread !== undefined ? { unreadCount: unread } : {}),
            ...(subject ? { name } : {}),
            ...(meta.archived !== undefined ? { archived: meta.archived } : {}),
            ...(meta.muted !== undefined ? { muted: meta.muted } : {}),
          },
        })
        .catch(() => null);
      if (row) this.emit('chat-upsert', accountId, this.chatRowToDto(accountId, row));
    }
  }

  private async onContactsUpsert(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contacts: any[],
  ): Promise<void> {
    for (const c of contacts) {
      await this.upsertContact(accountId, c);
    }
  }

  // Découple STRICTEMENT les deux noms: `name` = carnet d'adresses (c.name),
  // `pushName` = ce que le contact s'est donné (c.notify). On n'écrit jamais
  // l'un depuis l'autre, sinon un contacts.upsert "notify seul" écraserait le
  // nom du carnet par le pushName (les `undefined` ne touchent pas la colonne).
  private async upsertContact(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c: any,
  ): Promise<void> {
    if (!c?.id) return;
    const carnet = cleanName(c.name);
    const push = cleanName(c.notify);
    await this.prisma.waContact
      .upsert({
        where: { accountId_jid: { accountId, jid: c.id } },
        create: {
          accountId,
          jid: c.id,
          name: carnet,
          pushName: push,
          isGroup: isJidGroup(c.id) ?? false,
        },
        update: {
          ...(carnet ? { name: carnet } : {}),
          ...(push ? { pushName: push } : {}),
        },
      })
      .catch(() => undefined);
  }

  // Sujet d'un/plusieurs groupes (création / renommage) -> nom de la discussion.
  private async onGroupsUpsert(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    groups: any[],
  ): Promise<void> {
    for (const g of groups) {
      const subject = cleanName(g?.subject);
      if (!g?.id || !subject || this.isIgnoredChat(g.id)) continue;
      // upsert (pas update): un groupe tout neuf (création/jonction) n'a pas
      // encore de ligne de discussion -> il faut la créer, pas la rater.
      const row = await this.prisma.waChat
        .upsert({
          where: { accountId_jid: { accountId, jid: g.id } },
          create: {
            accountId,
            jid: g.id,
            name: subject,
            isGroup: isJidGroup(g.id) ?? true,
            unreadCount: 0,
          },
          update: { name: subject },
        })
        .catch(() => null);
      if (row) this.emit('chat-upsert', accountId, this.chatRowToDto(accountId, row));
    }
  }

  // Récupère le sujet de TOUS les groupes participés (1 requête) et renseigne le
  // nom des discussions de groupe (les événements de chat ne portent pas
  // toujours le sujet -> sinon affichage du JID brut). Une fois par ouverture.
  private async backfillGroupSubjects(accountId: string): Promise<void> {
    const s = this.ensureSession(accountId);
    if (!s.sock || s.connection.state !== ConnectionState.OPEN) return;
    // Garde anti-concurrence + throttle (pas de rejeu sur reconnexions rapprochées).
    if (s.groupBackfillRunning || Date.now() - s.groupBackfillAt < 30_000) {
      return;
    }
    s.groupBackfillRunning = true;
    s.groupBackfillAt = Date.now();
    try {
      const all = await this.withTimeout(
        s.sock.groupFetchAllParticipating(),
        WhatsappService.CHATMODIFY_TIMEOUT_MS,
      );
      // État courant des groupes (1 requête) -> on n'écrit/émet que sur changement.
      const existing = await this.prisma.waChat
        .findMany({
          where: { accountId, isGroup: true },
          select: { jid: true, name: true },
        })
        .catch(() => [] as { jid: string; name: string | null }[]);
      const current = new Map(existing.map((r) => [r.jid, r.name]));
      let fixed = 0;
      for (const [jid, meta] of Object.entries(all ?? {})) {
        if (!current.has(jid)) continue; // pas (encore) une discussion -> onGroupsUpsert/messages s'en chargent
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const display =
          cleanName((meta as any)?.subject) ??
          (await this.groupNameFromParticipants(accountId, meta));
        if (!display || current.get(jid) === display) continue; // inchangé
        const row = await this.prisma.waChat
          .update({ where: { accountId_jid: { accountId, jid } }, data: { name: display } })
          .catch(() => null);
        if (row) {
          fixed++;
          this.emit('chat-upsert', accountId, this.chatRowToDto(accountId, row));
        }
      }
      if (fixed > 0) {
        this.logger.log(`Sujets de groupe synchronisés (${fixed} discussion(s))`);
      }
    } catch (e) {
      this.logger.warn(`backfillGroupSubjects: ${e}`);
    } finally {
      s.groupBackfillRunning = false;
    }
  }

  // Groupe SANS sujet -> nom à la WhatsApp: noms des participants (hors soi),
  // les 3 premiers puis "+N". Repli sur le numéro si le nom est inconnu.
  private async groupNameFromParticipants(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meta: any,
  ): Promise<string | null> {
    const s = this.ensureSession(accountId);
    const parts: unknown[] = Array.isArray(meta?.participants)
      ? meta.participants
      : [];
    if (!parts.length) return null;
    // Identités de soi (numéro normalisé/canonique + LID) pour s'exclure de
    // façon fiable, les participants étant souvent adressés en @lid.
    const u = s.sock?.user;
    const selfSet = new Set<string>();
    if (u?.id) {
      selfSet.add(jidNormalizedUser(u.id));
      const c = this.canonicalJid(accountId, u.id);
      if (c) selfSet.add(c);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selfLid = (u as any)?.lid;
    if (typeof selfLid === 'string') selfSet.add(jidNormalizedUser(selfLid));
    const others = parts.filter((p) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = this.canonicalJid(accountId, (p as any)?.id);
      return !!j && !selfSet.has(j);
    });
    const names: string[] = [];
    for (const p of others.slice(0, 3)) {
      // resolvePn() résout activement le LID -> numéro (API native) ; on tombe
      // ensuite sur le nom du carnet, sinon le numéro (plutôt qu'un LID brut).
      const jid =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (await this.resolvePn(accountId, (p as any)?.id)) ??
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.canonicalJid(accountId, (p as any)?.id);
      if (!jid) continue;
      const n =
        (await this.nameFor(accountId, jid)) ?? jid.split('@')[0].split(':')[0];
      if (n) names.push(n);
    }
    if (!names.length) return null;
    const extra = others.length - names.length;
    return extra > 0 ? `${names.join(', ')} +${extra}` : names.join(', ');
  }

  // --- Envoi / actions ---

  async sendText(
    accountId = DEFAULT_ACCOUNT_ID,
    chatJid: string,
    text: string,
    clientId: string,
  ): Promise<WaMessage> {
    const s = this.ensureSession(accountId);
    if (!s.sock || s.connection.state !== ConnectionState.OPEN) {
      throw new Error('WhatsApp non connecté');
    }
    // Le numéro @s.whatsapp.net est toujours une cible d'envoi valide.
    const target = (await this.resolvePn(accountId, chatJid)) ?? chatJid;
    const sent = await s.sock.sendMessage(target, { text });
    const msg = sent ? mapWaMessage(sent, s.sock.user?.id, accountId) : null;
    if (!msg) throw new Error("Échec de l'envoi");
    msg.chatJid = this.canonicalJid(accountId, msg.chatJid) ?? msg.chatJid;
    msg.senderJid = this.canonicalJid(accountId, msg.senderJid);
    msg.clientId = clientId;
    if (!msg.text) msg.text = text;
    // L'envoi a réussi côté serveur WhatsApp -> au moins "envoyé" (✓),
    // les accusés delivered/read suivront via message-receipt.update.
    if (msg.status === WaMessageStatus.PENDING) msg.status = WaMessageStatus.SENT;
    await this.persistMessage(accountId, msg);
    const chat = await this.touchChat(accountId, msg);
    this.emit('message', accountId, msg);
    if (chat) this.emit('chat-upsert', accountId, chat);
    return msg;
  }

  // Envoi d'un média (image/vidéo/audio/document) depuis le pont vers WhatsApp.
  async sendMedia(
    accountId = DEFAULT_ACCOUNT_ID,
    chatJid: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
    caption?: string,
  ): Promise<WaMessage> {
    const s = this.ensureSession(accountId);
    if (!s.sock || s.connection.state !== ConnectionState.OPEN) {
      throw new Error('WhatsApp non connecté');
    }
    const target = (await this.resolvePn(accountId, chatJid)) ?? chatJid;

    // Contenu Baileys selon le type MIME du fichier uploadé.
    const mime = file.mimetype || 'application/octet-stream';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let content: any;
    if (mime.startsWith('image/')) {
      content = { image: file.buffer, caption: caption || undefined };
    } else if (mime.startsWith('video/')) {
      content = { video: file.buffer, caption: caption || undefined };
    } else if (mime.startsWith('audio/')) {
      content = { audio: file.buffer, mimetype: mime, ptt: false };
    } else {
      content = {
        document: file.buffer,
        fileName: file.originalname,
        mimetype: mime,
        caption: caption || undefined,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await s.sock.sendMessage(target, content as any);
    const msg = sent ? mapWaMessage(sent, s.sock.user?.id, accountId) : null;
    if (!msg) throw new Error("Échec de l'envoi du média");
    msg.chatJid = this.canonicalJid(accountId, msg.chatJid) ?? msg.chatJid;
    msg.senderJid = this.canonicalJid(accountId, msg.senderJid);

    // Message brut + SHA-256 du fichier (réutilise l'extraction média existante).
    const { rawContent, fileSha256 } = this.mediaInfoOf(sent?.message);

    // L'envoi a réussi côté serveur WhatsApp -> au moins "envoyé" (✓).
    if (msg.status === WaMessageStatus.PENDING) msg.status = WaMessageStatus.SENT;
    await this.persistMessage(accountId, msg, { rawMessage: rawContent, fileSha256 });

    // Écrit le buffer dans le cache média (même nom de fichier que getMedia)
    // pour un affichage immédiat sans re-télécharger. Ne doit pas faire échouer
    // l'envoi si le cache échoue.
    try {
      const safe = msg.id.replace(/[^a-zA-Z0-9]/g, '_');
      await mkdir(s.mediaDir, { recursive: true });
      await writeFile(join(s.mediaDir, safe), file.buffer);
    } catch (e) {
      this.logger.warn(`sendMedia cache ${msg.id}: ${e}`);
    }

    this.attachMediaUrl(msg);
    const chat = await this.touchChat(accountId, msg);
    this.emit('message', accountId, msg);
    if (chat) this.emit('chat-upsert', accountId, chat);
    return msg;
  }

  async markRead(accountId = DEFAULT_ACCOUNT_ID, chatJid: string): Promise<void> {
    const s = this.ensureSession(accountId);
    if (!s.sock) return;
    // Canonicalise vers le numéro pour le stockage local.
    const jid = (await this.resolvePn(accountId, chatJid)) ?? chatJid;
    const recent = await this.prisma.waMessage.findMany({
      where: { accountId, chatJid: jid, fromMe: false },
      orderBy: { sentAt: 'desc' },
      take: 30,
    });
    if (recent.length > 0) {
      const group = isJidGroup(jid) ?? false;
      // WhatsApp adresse souvent ces chats par LID: l'accusé de lecture doit
      // cibler le LID, sinon il est ignoré (le tél/l'expéditeur ne voient rien).
      const readJid = group ? jid : ((await this.getLid(accountId, jid)) ?? jid);
      const keys = recent.map((r) => ({
        remoteJid: readJid,
        id: r.id,
        fromMe: false,
        ...(group ? { participant: r.senderJid ?? undefined } : {}),
      }));
      try {
        await s.sock.readMessages(keys);
        this.logger.log(`markRead: ${keys.length} lu(s) sur ${readJid}`);
      } catch (e) {
        this.logger.warn(`markRead readMessages: ${e}`);
      }
    }
    // Remet le compteur à 0 ET notifie le front (sinon le badge reste affiché).
    const row = await this.prisma.waChat
      .update({ where: { accountId_jid: { accountId, jid } }, data: { unreadCount: 0 } })
      .catch(() => null);
    if (row) this.emit('chat-upsert', accountId, this.chatRowToDto(accountId, row));
  }

  // Archive / désarchive une discussion. WhatsApp exige le dernier message du
  // chat (clé + timestamp) pour cibler l'opération chatModify. On met TOUJOURS
  // à jour la colonne locale + on notifie le front, même si l'appel WhatsApp
  // échoue (ne jamais casser la connexion).
  // Marque un champ comme posé localement (garde contre l'écho WhatsApp).
  private guardLocalMeta(
    accountId: string,
    jid: string,
    field: 'archived' | 'muted',
  ): void {
    const s = this.ensureSession(accountId);
    const until = Date.now() + WhatsappService.LOCAL_META_GUARD_MS;
    const cur = s.localMetaGuard.get(jid) ?? {
      archivedUntil: 0,
      mutedUntil: 0,
    };
    if (field === 'archived') cur.archivedUntil = until;
    else cur.mutedUntil = until;
    s.localMetaGuard.set(jid, cur);
  }

  private isMetaGuarded(
    accountId: string,
    jid: string,
    field: 'archived' | 'muted',
  ): boolean {
    const s = this.ensureSession(accountId);
    const g = s.localMetaGuard.get(jid);
    if (!g) return false;
    const until = field === 'archived' ? g.archivedUntil : g.mutedUntil;
    return until > Date.now();
  }

  async setArchived(
    accountId = DEFAULT_ACCOUNT_ID,
    chatJid: string,
    archived: boolean,
  ): Promise<void> {
    const jid = (await this.resolvePn(accountId, chatJid)) ?? chatJid;
    this.guardLocalMeta(accountId, jid, 'archived');
    // 1) État local AUTORITAIRE: on met à jour la colonne + on notifie le front
    //    immédiatement (le pont reflète l'action sans dépendre de WhatsApp).
    const row = await this.prisma.waChat
      .update({ where: { accountId_jid: { accountId, jid } }, data: { archived } })
      .catch(() => null);
    if (row) this.emit('chat-upsert', accountId, this.chatRowToDto(accountId, row));
    // 2) Synchro WhatsApp en best-effort (NE PAS bloquer/awaiter: chatModify
    //    peut traîner ou ne jamais répondre selon l'état app-state).
    const last = await this.prisma.waMessage
      .findFirst({ where: { accountId, chatJid: jid }, orderBy: { sentAt: 'desc' } })
      .catch(() => null);
    const lastMessages = last
      ? [
          {
            key: { remoteJid: jid, id: last.id, fromMe: last.fromMe },
            messageTimestamp: Math.floor(last.sentAt.getTime() / 1000),
          },
        ]
      : [];
    void this.syncChatModify(
      accountId,
      jid,
      { archive: archived, lastMessages },
      'archive',
    );
  }

  // Active / désactive le mode silencieux (mute) d'une discussion. WhatsApp
  // attend une durée en ms (8h) pour muter, null pour réactiver le son.
  async setMuted(
    accountId = DEFAULT_ACCOUNT_ID,
    chatJid: string,
    muted: boolean,
  ): Promise<void> {
    const jid = (await this.resolvePn(accountId, chatJid)) ?? chatJid;
    this.guardLocalMeta(accountId, jid, 'muted');
    // 1) État local autoritaire d'abord (cf. setArchived).
    const row = await this.prisma.waChat
      .update({ where: { accountId_jid: { accountId, jid } }, data: { muted } })
      .catch(() => null);
    if (row) this.emit('chat-upsert', accountId, this.chatRowToDto(accountId, row));
    // 2) Synchro WhatsApp best-effort, sans bloquer.
    void this.syncChatModify(
      accountId,
      jid,
      { mute: muted ? 8 * 60 * 60 * 1000 : null },
      'mute',
    );
  }

  // Pousse une mutation app-state vers WhatsApp sans jamais bloquer l'appelant.
  // chatModify peut ne pas répondre: on borne par un timeout et on logge.
  private syncChatModify(
    accountId: string,
    jid: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod: any,
    label: string,
  ): void {
    const s = this.ensureSession(accountId);
    if (!s.sock || s.connection.state !== ConnectionState.OPEN) return;
    this.withTimeout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s.sock as any).chatModify(mod, jid) as Promise<unknown>,
      WhatsappService.CHATMODIFY_TIMEOUT_MS,
    )
      .then(() => this.logger.log(`chatModify(${label}) OK ${jid}`))
      .catch((e) => this.logger.warn(`chatModify(${label}) ${jid}: ${e}`));
  }

  // --- Blocage de contact / bio « À propos » ---

  // Re-lit la ligne chat et émet chat-upsert (reflète un changement de blocage,
  // comme le fait setMuted). Chat inconnu (1:1 jamais ouvert) -> rien à émettre.
  private async emitChatRefresh(accountId: string, jid: string): Promise<void> {
    const row = await this.prisma.waChat
      .findUnique({ where: { accountId_jid: { accountId, jid } } })
      .catch(() => null);
    if (row) this.emit('chat-upsert', accountId, this.chatRowToDto(accountId, row));
  }

  // Re-synchronise la liste des contacts bloqués (mémoire seule, pas de DB) via
  // fetchBlocklist à la connexion. Bornée par withTimeout, jamais bloquante.
  private async syncBlocklist(accountId: string): Promise<void> {
    const s = this.ensureSession(accountId);
    if (!s.sock || s.connection.state !== ConnectionState.OPEN) return;
    try {
      const list = await this.withTimeout(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s.sock as any).fetchBlocklist() as Promise<(string | undefined)[]>,
        WhatsappService.BLOCKLIST_TIMEOUT_MS,
      );
      s.blockedJids.clear();
      for (const j of list ?? []) {
        if (!j) continue;
        const jid = (await this.resolvePn(accountId, j)) ?? this.normJid(j);
        if (jid) s.blockedJids.add(jid);
      }
      this.logger.log(
        `Blocklist synchronisée: ${s.blockedJids.size} contact(s)` +
          (s.blockedJids.size
            ? ` [${[...s.blockedJids].join(', ')}]`
            : ''),
      );
    } catch (e) {
      this.logger.warn(`syncBlocklist: ${e}`);
    }
  }

  // Snapshot complet de la blocklist (event 'blocklist.set'): remplace tout le
  // set puis ré-émet les chats dont l'état de blocage a pu changer.
  private async onBlocklistSet(
    accountId: string,
    jids: string[],
  ): Promise<void> {
    const s = this.ensureSession(accountId);
    const next = new Set<string>();
    for (const j of jids) {
      if (!j) continue;
      const jid = (await this.resolvePn(accountId, j)) ?? this.normJid(j);
      if (jid) next.add(jid);
    }
    // Union ancien/nouveau: couvre les contacts nouvellement (dé)bloqués.
    const affected = new Set<string>([...s.blockedJids, ...next]);
    s.blockedJids.clear();
    for (const jid of next) s.blockedJids.add(jid);
    this.logger.log(`blocklist.set: ${s.blockedJids.size} contact(s) bloqué(s)`);
    for (const jid of affected) await this.emitChatRefresh(accountId, jid);
  }

  // Delta de la blocklist (event 'blocklist.update'): add/remove selon le type,
  // puis ré-émet chaque chat touché.
  private async onBlocklistUpdate(
    accountId: string,
    jids: string[],
    type: 'add' | 'remove',
  ): Promise<void> {
    const s = this.ensureSession(accountId);
    for (const j of jids) {
      if (!j) continue;
      const jid = (await this.resolvePn(accountId, j)) ?? this.normJid(j);
      if (!jid) continue;
      if (type === 'add') s.blockedJids.add(jid);
      else s.blockedJids.delete(jid);
      await this.emitChatRefresh(accountId, jid);
    }
    this.logger.log(`blocklist.update(${type}): ${jids.length} jid(s)`);
  }

  // Bloque / débloque un contact. État local AUTORITAIRE d'abord (set + emit),
  // puis synchro WhatsApp best-effort, sans bloquer (calque syncChatModify).
  async setBlocked(
    accountId = DEFAULT_ACCOUNT_ID,
    chatJid: string,
    blocked: boolean,
  ): Promise<void> {
    const s = this.ensureSession(accountId);
    const jid = (await this.resolvePn(accountId, chatJid)) ?? chatJid;
    // 1) État local autoritaire: maj du set + re-lecture/emit immédiat.
    if (blocked) s.blockedJids.add(jid);
    else s.blockedJids.delete(jid);
    await this.emitChatRefresh(accountId, jid);
    // 2) Synchro WhatsApp best-effort (NE PAS bloquer/awaiter).
    if (!s.sock || s.connection.state !== ConnectionState.OPEN) return;
    void this.withTimeout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s.sock as any).updateBlockStatus(
        jid,
        blocked ? 'block' : 'unblock',
      ) as Promise<unknown>,
      WhatsappService.BLOCK_TIMEOUT_MS,
    )
      .then(() =>
        this.logger.log(
          `updateBlockStatus(${blocked ? 'block' : 'unblock'}) OK ${jid}`,
        ),
      )
      .catch((e) => this.logger.warn(`updateBlockStatus ${jid}: ${e}`));
  }

  // Bio « À propos » d'un contact via fetchStatus. Hypothèse sur la forme:
  // res[0].status est soit une chaîne, soit { status, setAt: Date }. Best-effort:
  // toute erreur/indispo -> { status: null, setAt: null }.
  async getContactAbout(
    accountId = DEFAULT_ACCOUNT_ID,
    jid: string,
  ): Promise<WaContactAbout> {
    const s = this.ensureSession(accountId);
    const jid2 = (await this.resolvePn(accountId, jid)) ?? jid;
    try {
      const res = await this.withTimeout(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s.sock as any).fetchStatus(jid2) as Promise<any>,
        WhatsappService.STATUS_TIMEOUT_MS,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status0 = res?.[0]?.status;
      const text = typeof status0 === 'string' ? status0 : (status0?.status ?? null);
      const setAt = status0?.setAt ? new Date(status0.setAt).getTime() : null;
      return {
        status: cleanName(text) ?? null,
        setAt: Number.isFinite(setAt) ? setAt : null,
      };
    } catch {
      return { status: null, setAt: null };
    }
  }

  // Photo de profil d'un contact/groupe. Cache disque (fichier 'avatar_<jid>').
  // 404 (NotFoundException) si pas de photo -> le front affiche les initiales.
  // Protégé contre l'avalanche de requêtes: cache disque + cache négatif +
  // déduplication des requêtes en vol + limite de concurrence sur la socket.
  async getAvatar(
    accountId = DEFAULT_ACCOUNT_ID,
    jid: string,
  ): Promise<{ buffer: Buffer; mimetype: string }> {
    const s = this.ensureSession(accountId);
    const safe = 'avatar_' + jid.replace(/[^a-zA-Z0-9]/g, '_');
    const filePath = join(s.mediaDir, safe);

    // 1) Cache disque (photo déjà téléchargée) -> réponse immédiate.
    await mkdir(s.mediaDir, { recursive: true }).catch(() => undefined);
    const cached = await readFile(filePath).catch(() => null);
    if (cached) return { buffer: cached, mimetype: 'image/jpeg' };

    // 2) Cache négatif mémoire: on sait déjà qu'il n'y a pas de photo -> 404.
    const negUntil = s.avatarNoPhoto.get(jid);
    if (negUntil && negUntil > Date.now()) {
      throw new NotFoundException('Pas de photo de profil');
    }

    // 2b) Cache négatif disque (survit aux redémarrages): marqueur '<file>.none'.
    // Évite de re-questionner ~200 contacts sans photo à chaque redémarrage
    // (protège la session fragile d'un flot de requêtes IQ).
    const markerStat = await stat(filePath + '.none').catch(() => null);
    if (
      markerStat &&
      Date.now() - markerStat.mtimeMs < WhatsappService.AVATAR_NEG_TTL_MS
    ) {
      s.avatarNoPhoto.set(jid, markerStat.mtimeMs + WhatsappService.AVATAR_NEG_TTL_MS);
      throw new NotFoundException('Pas de photo de profil');
    }

    // 3) Déduplication: si une requête est déjà en vol pour ce jid, la partager.
    const existing = s.avatarInflight.get(jid);
    if (existing) return existing;

    const task = this.fetchAvatar(accountId, jid, filePath).finally(() => {
      s.avatarInflight.delete(jid);
    });
    s.avatarInflight.set(jid, task);
    return task;
  }

  private async fetchAvatar(
    accountId: string,
    jid: string,
    filePath: string,
  ): Promise<{ buffer: Buffer; mimetype: string }> {
    const s = this.ensureSession(accountId);
    // Connexion fermée = échec TRANSITOIRE: ne JAMAIS persister "pas de photo"
    // (sinon un avatar valide reste introuvable 24 h après une reconnexion).
    const sock = s.sock;
    if (!sock || s.connection.state !== ConnectionState.OPEN) {
      this.markTransientNoAvatar(accountId, jid);
      throw new NotFoundException('WhatsApp non connecté');
    }
    const release = await this.acquireAvatarSlot(accountId);
    try {
      let url: string | null | undefined;
      try {
        url = await this.profilePicUrl(sock, jid);
      } catch (e) {
        // 404 / photo privée = vraiment pas de photo (cache négatif long).
        // Timeout / connexion / autre = transitoire (réessai, pas de marqueur).
        if (this.isNoProfilePicError(e)) this.markNoAvatar(accountId, jid, filePath);
        else this.markTransientNoAvatar(accountId, jid);
        throw new NotFoundException('Pas de photo de profil');
      }
      if (!url) {
        // Réponse sans URL = pas de photo de profil.
        this.markNoAvatar(accountId, jid, filePath);
        throw new NotFoundException('Pas de photo de profil');
      }
      // URL obtenue (une photo EXISTE) ; échec de téléchargement = transitoire.
      const res = await this.withTimeout(
        fetch(url),
        WhatsappService.AVATAR_TIMEOUT_MS,
      ).catch(() => null);
      if (!res || !res.ok) {
        this.markTransientNoAvatar(accountId, jid);
        throw new NotFoundException('Photo indisponible (transitoire)');
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(filePath, buf).catch(() => undefined);
      // Photo trouvée: purge un éventuel marqueur négatif obsolète.
      await unlink(filePath + '.none').catch(() => undefined);
      s.avatarNoPhoto.delete(jid);
      return {
        buffer: buf,
        mimetype: res.headers.get('content-type') ?? 'image/jpeg',
      };
    } catch (e) {
      // Erreur résiduelle inattendue (lecture du flux…) -> transitoire (pas 500).
      if (e instanceof NotFoundException) throw e;
      this.markTransientNoAvatar(accountId, jid);
      this.logger.warn(`getAvatar ${jid}: ${e}`);
      throw new NotFoundException('Photo indisponible (transitoire)');
    } finally {
      release();
    }
  }

  // Tente la photo pleine ('image') puis, sur échec NON-définitif, la miniature
  // ('preview'): une requête 'image' qui traîne répond souvent en 'preview'.
  private async profilePicUrl(
    sock: WASocket,
    jid: string,
  ): Promise<string | undefined> {
    try {
      return await this.withTimeout(
        sock.profilePictureUrl(jid, 'image'),
        WhatsappService.AVATAR_TIMEOUT_MS,
      );
    } catch (e) {
      if (this.isNoProfilePicError(e)) throw e; // vraie absence -> propage
      return await this.withTimeout(
        sock.profilePictureUrl(jid, 'preview'),
        WhatsappService.AVATAR_TIMEOUT_MS,
      );
    }
  }

  // Mémorise (mémoire + marqueur disque, TTL long) qu'un jid n'a PAS de photo.
  private markNoAvatar(accountId: string, jid: string, filePath: string): void {
    const s = this.ensureSession(accountId);
    s.avatarNoPhoto.set(jid, Date.now() + WhatsappService.AVATAR_NEG_TTL_MS);
    // Marqueur disque vide: la fraîcheur est lue via le mtime du fichier.
    writeFile(filePath + '.none', '').catch(() => undefined);
  }

  // Échec TRANSITOIRE (déconnexion / timeout / CDN): on évite seulement le
  // martèlement ~1 min, SANS marqueur disque ni TTL long -> réessai auto ensuite.
  private markTransientNoAvatar(accountId: string, jid: string): void {
    const s = this.ensureSession(accountId);
    s.avatarNoPhoto.set(jid, Date.now() + 60_000);
  }

  // Vrai si l'erreur signifie "pas de photo" (404) ou photo privée (401/403).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private isNoProfilePicError(e: any): boolean {
    const code = e?.output?.statusCode ?? e?.data?.statusCode ?? e?.statusCode;
    const msg = String(e?.message ?? '').toLowerCase();
    return (
      code === 404 ||
      code === 401 ||
      code === 403 ||
      msg.includes('item-not-found') ||
      msg.includes('not-authorized')
    );
  }

  // Sémaphore: limite le nombre de requêtes simultanées de photo sur la socket.
  private async acquireAvatarSlot(accountId: string): Promise<() => void> {
    const s = this.ensureSession(accountId);
    await new Promise<void>((resolve) => {
      if (s.avatarActive < WhatsappService.AVATAR_MAX_CONCURRENT) {
        s.avatarActive++;
        resolve();
      } else {
        s.avatarQueue.push(() => {
          s.avatarActive++;
          resolve();
        });
      }
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.avatarActive--;
      const next = s.avatarQueue.shift();
      if (next) next();
    };
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  // LID d'un numéro via l'API native (pour cibler les accusés de lecture).
  private async getLid(accountId: string, pnJid: string): Promise<string | null> {
    const s = this.ensureSession(accountId);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lm = (s.sock as any)?.signalRepository?.lidMapping;
      const lid: string | null | undefined = lm?.getLIDForPN
        ? await lm.getLIDForPN(pnJid)
        : null;
      return lid && isLidUser(lid) ? lid : null;
    } catch {
      return null;
    }
  }

  async setTyping(
    accountId = DEFAULT_ACCOUNT_ID,
    chatJid: string,
    typing: boolean,
  ): Promise<void> {
    const s = this.ensureSession(accountId);
    if (!s.sock || s.connection.state !== ConnectionState.OPEN) return;
    await s.sock
      .sendPresenceUpdate(typing ? 'composing' : 'paused', chatJid)
      .catch(() => undefined);
  }

  // S'abonne à la présence d'un contact. WhatsApp adresse par LID -> on tente
  // le LID, sinon le jid tel quel. Ne doit jamais casser la connexion.
  async subscribePresence(
    accountId = DEFAULT_ACCOUNT_ID,
    chatJid: string,
  ): Promise<void> {
    const s = this.ensureSession(accountId);
    if (!s.sock || s.connection.state !== ConnectionState.OPEN) return;
    try {
      const target = (await this.getLid(accountId, chatJid)) ?? chatJid;
      await s.sock.presenceSubscribe(target);
    } catch (e) {
      this.logger.warn(`subscribePresence ${chatJid}: ${e}`);
    }
  }

  // Présence entrante. Forme 7.x:
  //   { id: chatJid, presences: { [participantJid]: { lastKnownPresence, lastSeen? } } }
  // En DM, on prend la 1ère entrée (l'interlocuteur).
  // Frontière Baileys -> typage borné à any.
  private async onPresence(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    u: any,
  ): Promise<void> {
    try {
      const id: string | undefined = u?.id;
      if (!id) return;
      const presences = u?.presences ?? {};
      const first = Object.values(presences)[0] as
        | { lastKnownPresence?: string | null }
        | undefined;
      const presence: WaPresence = {
        accountId,
        jid: (await this.resolvePn(accountId, id)) ?? id,
        kind: this.mapPresence(first?.lastKnownPresence),
        at: Date.now(),
      };
      this.emit('presence', accountId, presence);
    } catch (e) {
      this.logger.warn(`onPresence: ${e}`);
    }
  }

  // Mappe la présence Baileys vers PresenceKind du contrat.
  private mapPresence(p: string | null | undefined): PresenceKind {
    switch (p) {
      case 'available':
        return PresenceKind.AVAILABLE;
      case 'composing':
        return PresenceKind.COMPOSING;
      case 'recording':
        return PresenceKind.RECORDING;
      case 'paused':
        return PresenceKind.PAUSED;
      case 'unavailable':
      default:
        return PresenceKind.UNAVAILABLE;
    }
  }

  // --- Lecture (REST) ---

  async listChats(accountId = DEFAULT_ACCOUNT_ID): Promise<WaChat[]> {
    const rows = await this.prisma.waChat.findMany({
      where: { accountId },
      orderBy: [{ lastMessageAt: 'desc' }],
      take: 500,
    });
    return rows
      .filter((r) => !this.isIgnoredChat(r.jid))
      .filter((r) => !this.isPlaceholderChat(r))
      .map((r) => this.chatRowToDto(accountId, r));
  }

  // Discussion "fantôme": sans nom ET sans aperçu de message (souvent un @lid
  // stray créé par la synchro avec un conversationTimestamp mais 0 message).
  // Affichée, elle ne montrerait que le numéro brut.
  private isPlaceholderChat(r: {
    name: string | null;
    lastMessagePreview: string | null;
  }): boolean {
    return !cleanName(r.name) && !cleanName(r.lastMessagePreview);
  }

  async listMessages(
    accountId = DEFAULT_ACCOUNT_ID,
    chatJid: string,
    before: number | null,
    limit: number,
  ): Promise<{ messages: WaMessage[]; hasMore: boolean; nextBefore: number | null }> {
    const rows = await this.prisma.waMessage.findMany({
      where: {
        accountId,
        chatJid,
        ...(before ? { sentAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { sentAt: 'desc' },
      take: limit + 1,
    });
    const { page, hasMore, nextBefore } = this.paginateBySecond(rows, limit);
    return {
      messages: page.map((r) => this.msgRowToDto(accountId, r)),
      hasMore,
      nextBefore,
    };
  }

  // Galerie média d'une discussion: TOUS les médias, récents d'abord. On
  // canonicalise le JID (numéro) comme les autres méthodes, on filtre les
  // messages porteurs d'un média, puis on réutilise msgRowToDto (qui pose
  // media + l'url via attachMediaUrl) avant de projeter sur WaMediaItem. Les
  // lignes sans média réel (ex: message supprimé) sont ignorées.
  async listChatMedia(
    accountId = DEFAULT_ACCOUNT_ID,
    chatJid: string,
  ): Promise<WaMediaItem[]> {
    const jid = (await this.resolvePn(accountId, chatJid)) ?? chatJid;
    const rows = await this.prisma.waMessage.findMany({
      where: {
        accountId,
        chatJid: jid,
        type: { in: [...WhatsappService.MEDIA_TYPES] },
      },
      orderBy: { sentAt: 'desc' },
      // Borné + `select` SANS rawMessage (gros blob proto inutile pour la galerie).
      take: WhatsappService.MEDIA_GALLERY_LIMIT,
      select: {
        id: true,
        chatJid: true,
        fromMe: true,
        senderJid: true,
        senderName: true,
        type: true,
        text: true,
        sentAt: true,
        status: true,
        quotedId: true,
        media: true,
        reactions: true,
        clientId: true,
      },
    });
    const items: WaMediaItem[] = [];
    for (const row of rows) {
      const dto = this.msgRowToDto(accountId, row);
      const media = dto.media;
      if (!media) continue; // pas de média réel -> ignoré
      items.push({
        accountId,
        id: dto.id,
        kind: media.kind,
        mimetype: media.mimetype,
        fileName: media.fileName,
        caption: media.caption,
        url: media.url,
        thumbnailBase64: media.thumbnailBase64,
        timestamp: dto.timestamp,
        fromMe: dto.fromMe,
      });
    }
    return items;
  }

  // Détail des accusés par destinataire pour le panneau « Infos du message ».
  // jid encodé côté client (encodeURIComponent) ; Express le décode en param.
  async getMessageInfo(
    accountId = DEFAULT_ACCOUNT_ID,
    chatJid: string,
    id: string,
  ): Promise<WaMessageInfoResponse> {
    const jid = (await this.resolvePn(accountId, chatJid)) ?? chatJid;
    const row = await this.prisma.waMessage.findUnique({
      where: { accountId_chatJid_id: { accountId, chatJid: jid, id } },
      select: { fromMe: true, sentAt: true, receipts: true },
    });
    if (!row) throw new NotFoundException('Message introuvable.');
    const isGroup = isJidGroup(jid) ?? false;
    // Résout le nom affichable à la lecture (le JSON stocké garde name = null).
    const stored = (row.receipts as WaMessageReceipt[] | null) ?? [];
    const receipts: WaMessageReceipt[] = [];
    for (const r of stored) {
      receipts.push({ ...r, name: await this.nameFor(accountId, r.userJid) });
    }
    // Tri : lus d'abord (readAt desc), puis distribués (deliveredAt desc), puis le reste.
    const rank = (r: WaMessageReceipt): number =>
      r.readAt != null ? 0 : r.deliveredAt != null ? 1 : 2;
    receipts.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return (b.readAt ?? 0) - (a.readAt ?? 0);
      if (ra === 1) return (b.deliveredAt ?? 0) - (a.deliveredAt ?? 0);
      return 0;
    });
    return {
      accountId,
      id,
      chatJid: jid,
      isGroup,
      sentAt: row.sentAt.getTime(),
      receipts,
    };
  }

  // --- Vue fusionnée par personne (multi-compte) ---

  // Personnes (contacts 1:1) agrégées à travers TOUS les comptes liés, pour la
  // vue fusionnée (Phase 3). Identité = JID pn canonique : le même numéro vu par
  // plusieurs comptes = une seule personne. Groupes exclus ; discussions ignorées
  // (status/newsletter) et fantômes (@lid sans nom ni aperçu) écartées.
  async listPeople(): Promise<WaPeopleResponse> {
    const rows = await this.prisma.waChat.findMany({
      where: { isGroup: false },
    });
    interface Agg {
      jid: string;
      accountIds: string[];
      name: string | null;
      preview: string | null;
      primaryAccountId: string;
      bestTs: number; // max(lastMessageAt) vu ; -1 si aucune discussion encore agrégée
      // Non-lus par compte (dédup intra-compte des lignes @lid + pn) ; sommés à la fin.
      unreadByAccount: Map<string, number>;
      allMuted: boolean; // vrai seulement si TOUTES les discussions sont muettes
      allArchived: boolean; // idem archivées
    }
    // Combine les non-lus de deux lignes d'un MÊME compte (doublon @lid + pn du
    // même contact): pas de double comptage. Ordre de priorité: non-lus positifs
    // (on garde le max, pas la somme) > « marqué non lu » (-1) > lu (0).
    const combineAccountUnread = (a: number, b: number): number => {
      if (a > 0 || b > 0) return Math.max(a, b);
      if (a === -1 || b === -1) return -1;
      return 0;
    };
    const map = new Map<string, Agg>();
    for (const r of rows) {
      if (this.isIgnoredChat(r.jid)) continue;
      if (this.isPlaceholderChat(r)) continue;
      // Canonicalise (@lid -> pn via le cache mémoire du compte, comme
      // chatRowToDto) pour regrouper le même numéro à travers les comptes.
      const jid = this.canonicalJid(r.accountId, r.jid) ?? r.jid;
      const ts = r.lastMessageAt ? r.lastMessageAt.getTime() : null;
      const name = cleanName(r.name);
      const preview = cleanName(r.lastMessagePreview);
      let a = map.get(jid);
      if (!a) {
        a = {
          jid,
          accountIds: [],
          name: null,
          preview: null,
          primaryAccountId: r.accountId,
          bestTs: -1,
          unreadByAccount: new Map(),
          allMuted: true,
          allArchived: true,
        };
        map.set(jid, a);
      }
      if (!a.accountIds.includes(r.accountId)) a.accountIds.push(r.accountId);
      a.unreadByAccount.set(
        r.accountId,
        combineAccountUnread(
          a.unreadByAccount.get(r.accountId) ?? 0,
          r.unreadCount,
        ),
      );
      a.allMuted = a.allMuted && r.muted;
      a.allArchived = a.allArchived && r.archived;
      // La discussion la plus récente fixe le compte primaire, le nom et l'aperçu.
      const effTs = ts ?? 0;
      if (effTs > a.bestTs) {
        a.bestTs = effTs;
        a.primaryAccountId = r.accountId;
        a.preview = preview;
        if (name) a.name = name;
      }
      // Repli: garder un nom même si la discussion primaire n'en a pas.
      if (!a.name && name) a.name = name;
    }
    const people: WaPerson[] = [];
    for (const a of map.values()) {
      // Somme des non-lus entre comptes (déjà dédupliqués par compte).
      let unreadSum = 0;
      let marked = false;
      for (const v of a.unreadByAccount.values()) {
        if (v > 0) unreadSum += v;
        else if (v === -1) marked = true;
      }
      people.push({
        jid: a.jid,
        name: a.name,
        avatarUrl: '/api/wa/avatar/' + encodeURIComponent(a.jid),
        accountIds: a.accountIds,
        primaryAccountId: a.primaryAccountId,
        unreadCount: unreadSum > 0 ? unreadSum : marked ? -1 : 0,
        lastMessageTs: a.bestTs > 0 ? a.bestTs : null,
        lastMessagePreview: a.preview,
        muted: a.allMuted,
        archived: a.allArchived,
      });
    }
    // Récentes d'abord (comme la liste de discussions).
    people.sort((x, y) => (y.lastMessageTs ?? 0) - (x.lastMessageTs ?? 0));
    return { people };
  }

  // Timeline fusionnée d'une personne : messages de TOUS les comptes partageant
  // ce JID pn, triés par date (curseur `before` sur sentAt). Chaque message garde
  // son accountId d'origine (média/avatar routés côté client par authedMediaUrl).
  async listPersonTimeline(
    jid: string,
    before: number | null,
    limit: number,
  ): Promise<{
    messages: WaMessage[];
    hasMore: boolean;
    nextBefore: number | null;
  }> {
    const rows = await this.prisma.waMessage.findMany({
      where: {
        chatJid: jid,
        ...(before ? { sentAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { sentAt: 'desc' },
      take: limit + 1,
      // `select` SANS rawMessage (gros blob proto inutile ici).
      select: {
        accountId: true,
        id: true,
        chatJid: true,
        fromMe: true,
        senderJid: true,
        senderName: true,
        type: true,
        text: true,
        sentAt: true,
        status: true,
        quotedId: true,
        media: true,
        reactions: true,
        clientId: true,
      },
    });
    const { page, hasMore, nextBefore } = this.paginateBySecond(rows, limit);
    return {
      messages: page.map((r) => this.msgRowToDto(r.accountId, r)),
      hasMore,
      nextBefore,
    };
  }

  // Découpe une page de messages (rows triées sentAt DESC, longueur <= limit+1)
  // en coupant TOUJOURS entre deux secondes distinctes. Les horodatages WhatsApp
  // sont à la seconde: avec un curseur strict `sentAt < before`, couper au milieu
  // d'une seconde perdrait définitivement les messages restants de cette seconde
  // (fréquent en entrelaçant plusieurs comptes). Retourne la page en ordre chrono
  // croissant + le curseur `nextBefore` (à repasser tel quel).
  private paginateBySecond<T extends { sentAt: Date }>(
    rows: T[],
    limit: number,
  ): { page: T[]; hasMore: boolean; nextBefore: number | null } {
    if (rows.length <= limit) {
      return { page: [...rows].reverse(), hasMore: false, nextBefore: null };
    }
    // Il existe au moins une page plus ancienne (rows.length === limit + 1).
    const boundary = rows[limit].sentAt.getTime(); // seconde du 1er message exclu
    // Retire de la page les messages de la seconde-frontière: ils reviendront
    // dans la page suivante via `< nextBefore` (dédupliqués côté client).
    let end = limit;
    while (end > 0 && rows[end - 1].sentAt.getTime() === boundary) end--;
    if (end === 0) {
      // Cas dégénéré: > limit messages à la même seconde. On renvoie la page
      // pleine et on avance d'une seconde (évite une boucle infinie ; risque
      // théorique de sauter la fin de cette seconde, négligeable en 1:1).
      const page = rows.slice(0, limit).reverse();
      return { page, hasMore: true, nextBefore: boundary };
    }
    const page = rows.slice(0, end).reverse();
    return { page, hasMore: true, nextBefore: page[0].sentAt.getTime() };
  }

  // --- Persistance / helpers ---

  // Champs média facultatifs (présents uniquement pour les messages média).
  private toMessageRow(
    accountId: string,
    m: WaMessage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extra?: { rawMessage?: any; fileSha256?: string | null },
  ) {
    return {
      accountId,
      id: m.id,
      chatJid: m.chatJid,
      fromMe: m.fromMe,
      senderJid: m.senderJid,
      senderName: m.senderName,
      type: m.type,
      text: m.text,
      sentAt: new Date(m.timestamp || Date.now()),
      status: m.status,
      quotedId: m.quotedId,
      media: (m.media ?? undefined) as Prisma.InputJsonValue | undefined,
      reactions: (m.reactions ?? []) as unknown as Prisma.InputJsonValue,
      clientId: m.clientId,
      ...(extra?.rawMessage !== undefined
        ? { rawMessage: extra.rawMessage as unknown as Prisma.InputJsonValue }
        : {}),
      ...(extra?.fileSha256 !== undefined ? { fileSha256: extra.fileSha256 } : {}),
    };
  }

  private async persistMessage(
    accountId: string,
    m: WaMessage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extra?: { rawMessage?: any; fileSha256?: string | null },
  ): Promise<void> {
    const row = this.toMessageRow(accountId, m, extra);
    await this.prisma.waMessage
      .upsert({
        where: {
          accountId_chatJid_id: { accountId, chatJid: m.chatJid, id: m.id },
        },
        create: row,
        update: {
          status: m.status,
          text: m.text,
          media: row.media,
          // Ne pas écraser rawMessage/fileSha256 existants si non fournis.
          ...(extra?.rawMessage !== undefined
            ? {
                rawMessage: extra.rawMessage as unknown as Prisma.InputJsonValue,
              }
            : {}),
          ...(extra?.fileSha256 !== undefined && extra.fileSha256 !== null
            ? { fileSha256: extra.fileSha256 }
            : {}),
        },
      })
      .catch((e) => this.logger.error(`persistMessage: ${e}`));
  }

  // --- Média: extraction, dédup, URL, téléchargement ---

  // Extrait le nœud média brut (déballé) du contenu d'un message:
  // - rawContent: le message brut à conserver (proto IMessage) pour re-télécharger.
  // - fileSha256: SHA-256 du fichier (Uint8Array) encodé en base64 -> clé de dédup.
  // Frontière Baileys -> typage borné à any.
  private mediaInfoOf(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rawMessageContent: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): { rawContent: any; fileSha256: string | null } {
    try {
      const content = rawMessageContent
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (normalizeMessageContent(rawMessageContent) as any)
        : null;
      if (!content) return { rawContent: rawMessageContent ?? null, fileSha256: null };
      const node =
        content.imageMessage ??
        content.videoMessage ??
        content.audioMessage ??
        content.documentMessage ??
        content.stickerMessage ??
        null;
      const sha: Uint8Array | undefined = node?.fileSha256;
      const fileSha256 =
        sha && sha.length ? Buffer.from(sha).toString('base64') : null;
      return { rawContent: rawMessageContent, fileSha256 };
    } catch {
      return { rawContent: rawMessageContent ?? null, fileSha256: null };
    }
  }

  // Double livraison LID: un message du MÊME chat a déjà ce fichier (id différent).
  private async isDuplicateMedia(
    accountId: string,
    m: WaMessage,
    fileSha256: string,
  ): Promise<boolean> {
    const existing = await this.prisma.waMessage
      .findFirst({
        where: { accountId, chatJid: m.chatJid, fileSha256, id: { not: m.id } },
      })
      .catch(() => null);
    return existing !== null;
  }

  // Renseigne l'URL backend du média (servie déchiffrée à la demande).
  private attachMediaUrl(m: WaMessage): void {
    if (m.media) {
      m.media.url = `/api/wa/media/${encodeURIComponent(m.chatJid)}/${m.id}`;
    }
  }

  // Renvoie le binaire d'un média (cache disque, sinon téléchargement Baileys).
  async getMedia(
    accountId = DEFAULT_ACCOUNT_ID,
    chatJid: string,
    id: string,
  ): Promise<{ buffer: Buffer; mimetype: string; fileName: string | null }> {
    const s = this.ensureSession(accountId);
    const row = await this.prisma.waMessage
      .findUnique({ where: { accountId_chatJid_id: { accountId, chatJid, id } } })
      .catch(() => null);
    if (!row || !row.rawMessage) {
      throw new NotFoundException(
        'Média indisponible (message trop ancien — renvoyez-le).',
      );
    }
    const media = (row.media as unknown as WaMessage['media']) ?? null;
    const mimetype = media?.mimetype ?? 'application/octet-stream';
    const fileName = media?.fileName ?? null;

    const safe = id.replace(/[^a-zA-Z0-9]/g, '_');
    const filePath = join(s.mediaDir, safe);
    try {
      await mkdir(s.mediaDir, { recursive: true });
      const cached = await readFile(filePath).catch(() => null);
      if (cached) return { buffer: cached, mimetype, fileName };

      if (!s.sock) throw new Error('WhatsApp non connecté');
      const buffer = (await downloadMediaMessage(
        // Frontière Baileys -> typage borné.
        {
          key: { remoteJid: chatJid, id, fromMe: row.fromMe },
          message: row.rawMessage,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        'buffer',
        {},
        {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          logger: this.waLogger as any,
          reuploadRequest: s.sock.updateMediaMessage,
        },
      )) as Buffer;
      await writeFile(filePath, buffer).catch(() => undefined);
      return { buffer, mimetype, fileName };
    } catch (e) {
      this.logger.error(`getMedia ${chatJid}/${id}: ${e}`);
      throw new NotFoundException(
        'Média indisponible (échec du téléchargement — réessayez plus tard).',
      );
    }
  }

  private async touchChat(
    accountId: string,
    m: WaMessage,
  ): Promise<WaChat | null> {
    const name = await this.nameFor(accountId, m.chatJid);
    const at = new Date(m.timestamp || Date.now());
    const preview = previewOf(m);
    const row = await this.prisma.waChat
      .upsert({
        where: { accountId_jid: { accountId, jid: m.chatJid } },
        create: {
          accountId,
          jid: m.chatJid,
          name,
          isGroup: isJidGroup(m.chatJid) ?? false,
          // Le compteur de non-lus est géré par chats.update (valeur autoritaire
          // de WhatsApp) — touchChat n'y touche pas (évite le double comptage
          // dû à la double livraison LID + téléphone du même message).
          unreadCount: 0,
          lastMessageAt: at,
          lastMessagePreview: preview,
        },
        update: {
          lastMessageAt: at,
          lastMessagePreview: preview,
          name: name ?? undefined,
        },
      })
      .catch(() => null);
    return row ? this.chatRowToDto(accountId, row) : null;
  }

  private async nameFor(accountId: string, jid: string): Promise<string | null> {
    if (isJidGroup(jid)) return null;
    const c = await this.prisma.waContact
      .findUnique({ where: { accountId_jid: { accountId, jid } } })
      .catch(() => null);
    // Carnet d'adresses (name) d'abord, pushName en repli.
    return cleanName(c?.name) ?? cleanName(c?.pushName) ?? null;
  }

  // Nom à afficher pour une discussion. Groupe -> sujet (ch.name de Baileys).
  // 1:1 -> on PRÉFÈRE le carnet d'adresses (nameFor) au ch.name de Baileys, qui
  // peut être un pushName et masquerait le nom que tu as enregistré.
  private async chatDisplayName(
    accountId: string,
    jid: string,
    rawChatName: unknown,
  ): Promise<string | null> {
    const subject = cleanName(rawChatName);
    if (isJidGroup(jid)) return subject;
    return (await this.nameFor(accountId, jid)) ?? subject;
  }

  // --- LID / canonicalisation ---

  // Charge la table wa_lid_map en mémoire au démarrage (scopée par compte).
  private async loadLidMap(accountId = DEFAULT_ACCOUNT_ID): Promise<void> {
    const s = this.ensureSession(accountId);
    try {
      const rows = await this.prisma.waLidMap.findMany({ where: { accountId } });
      for (const r of rows) s.lidToPn.set(r.lid, r.pn);
      this.logger.log(`Carte LID chargée: ${rows.length} entrée(s)`);
    } catch (e) {
      this.logger.warn(`loadLidMap: ${e}`);
    }
  }

  // Retourne le @s.whatsapp.net canonique d'un JID @lid si connu, sinon le JID.
  // Normalise un JID utilisateur en retirant le suffixe d'appareil/agent
  // (ex: "33...:0@s.whatsapp.net" -> "33...@s.whatsapp.net", idem @lid). Sans
  // ça, WhatsApp livre parfois la même personne sous deux JID -> doublons de
  // discussions avec non-lus fantômes. Les groupes/broadcast restent intacts.
  private normJid(jid: string): string {
    if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) {
      try {
        return jidNormalizedUser(jid);
      } catch {
        return jid;
      }
    }
    return jid;
  }

  private canonicalJid(
    accountId: string,
    jid: string | null | undefined,
  ): string | null {
    if (!jid) return null;
    const s = this.ensureSession(accountId);
    const norm = this.normJid(jid);
    if (!isLidUser(norm)) return norm;
    return s.lidToPn.get(norm) ?? s.lidToPn.get(jid) ?? norm;
  }

  // Discussions à NE PAS afficher: Status/Stories (status@broadcast) et
  // newsletters/channels — ce ne sont pas des conversations.
  private isIgnoredChat(jid: string | null | undefined): boolean {
    if (!jid) return true;
    return jid === 'status@broadcast' || jid.endsWith('@newsletter');
  }

  // Résout un JID @lid vers son numéro via l'API LID NATIVE de Baileys 7.x
  // (signalRepository.lidMapping.getPNForLID). Mémorise + fusionne via learnLid.
  // Retourne le JID inchangé si non @lid ou non résoluble.
  private async resolvePn(
    accountId: string,
    jid: string | null | undefined,
  ): Promise<string | null> {
    if (!jid) return null;
    const s = this.ensureSession(accountId);
    const norm = this.normJid(jid);
    if (!isLidUser(norm)) return norm;
    const cached = s.lidToPn.get(norm);
    if (cached) return cached;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lm = (s.sock as any)?.signalRepository?.lidMapping;
      const pn: string | null | undefined = lm?.getPNForLID
        ? await lm.getPNForLID(norm)
        : null;
      if (pn && pn.endsWith('@s.whatsapp.net')) {
        await this.learnLid(accountId, norm, pn);
        return this.normJid(pn);
      }
    } catch {
      /* noop */
    }
    return norm;
  }

  // Apprend les correspondances LID->numéro portées par une clé de message.
  private async learnFromKey(
    accountId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    key: any,
  ): Promise<void> {
    try {
      if (!key) return;
      const remoteJid: string | undefined = key.remoteJid ?? undefined;
      const participant: string | undefined = key.participant ?? undefined;

      // Cas où les deux identités sont fournies ensemble.
      if (key.senderLid && key.senderPn) {
        await this.learnLid(accountId, key.senderLid, key.senderPn);
      }
      if (participant && key.participantPn) {
        await this.learnLid(accountId, participant, key.participantPn);
      }
      // DM: remoteJid est le LID, senderPn fournit le numéro.
      if (remoteJid && isLidUser(remoteJid) && key.senderPn) {
        await this.learnLid(accountId, remoteJid, key.senderPn);
      }
      // DM: remoteJid est le numéro, senderLid fournit le LID.
      if (
        remoteJid &&
        remoteJid.endsWith('@s.whatsapp.net') &&
        key.senderLid
      ) {
        await this.learnLid(accountId, key.senderLid, remoteJid);
      }
      // Groupe: participant est le LID, participantPn fournit le numéro.
      if (participant && isLidUser(participant) && key.participantPn) {
        await this.learnLid(accountId, participant, key.participantPn);
      }
    } catch (e) {
      this.logger.warn(`learnFromKey: ${e}`);
    }
  }

  // Enregistre une correspondance LID->numéro (mémoire + DB) et fusionne
  // rétroactivement le chat @lid existant dans le chat numéro.
  private async learnLid(
    accountId: string,
    lidRaw: string,
    pnRaw: string,
  ): Promise<void> {
    const s = this.ensureSession(accountId);
    let lid: string;
    let pn: string;
    try {
      lid = jidNormalizedUser(lidRaw);
      pn = jidNormalizedUser(pnRaw);
    } catch {
      return;
    }
    if (!isLidUser(lid)) return;
    if (!pn.endsWith('@s.whatsapp.net')) return;
    if (s.lidToPn.get(lid) === pn) return; // déjà connu

    s.lidToPn.set(lid, pn);

    try {
      await this.prisma.waLidMap.upsert({
        where: { accountId_lid: { accountId, lid } },
        create: { accountId, lid, pn },
        update: { pn },
      });
    } catch (e) {
      this.logger.warn(`learnLid upsert: ${e}`);
    }

    // Fusion rétroactive — ne doit jamais casser la connexion WhatsApp.
    try {
      await this.mergeLidChat(accountId, lid, pn);
      // Pendant la synchro d'historique, on évite un flot d'emit (un seul à la fin).
      if (!s.historySyncing) this.emit('chats', accountId, await this.listChats(accountId));
    } catch (e) {
      this.logger.warn(`mergeLidChat ${lid} -> ${pn}: ${e}`);
    }
  }

  // Déplace messages + chat du JID @lid vers le numéro, en gérant la collision
  // de clé primaire (même id présent sous les 2 jids). Toutes les requêtes
  // brutes sont scopées par account_id (paramétré, jamais interpolé).
  private async mergeLidChat(
    accountId: string,
    lid: string,
    pn: string,
  ): Promise<void> {
    // a. Réaffecte au numéro les messages absents (par id) sous le numéro.
    await this.prisma.$executeRaw`
      UPDATE "wa_messages" SET "chat_jid" = ${pn}
      WHERE "chat_jid" = ${lid}
        AND "account_id" = ${accountId}
        AND NOT EXISTS (
          SELECT 1 FROM "wa_messages" w
          WHERE w."chat_jid" = ${pn} AND w."id" = "wa_messages"."id"
            AND w."account_id" = ${accountId}
        )`;
    // b. Supprime les doublons restés sous le lid.
    await this.prisma
      .$executeRaw`DELETE FROM "wa_messages" WHERE "chat_jid" = ${lid} AND "account_id" = ${accountId}`;
    // c. Corrige l'expéditeur (y compris dans les groupes).
    await this.prisma
      .$executeRaw`UPDATE "wa_messages" SET "sender_jid" = ${pn} WHERE "sender_jid" = ${lid} AND "account_id" = ${accountId}`;
    // d. Supprime le chat lid.
    await this.prisma
      .$executeRaw`DELETE FROM "wa_chats" WHERE "jid" = ${lid} AND "account_id" = ${accountId}`;
    // e. Recalcule / assure le chat numéro à partir de son dernier message.
    await this.ensurePnChat(accountId, pn);
  }

  // Assure l'existence du chat numéro et recale aperçu/horodatage sur le dernier
  // message connu pour ce numéro.
  private async ensurePnChat(accountId: string, pn: string): Promise<void> {
    const last = await this.prisma.waMessage
      .findFirst({ where: { accountId, chatJid: pn }, orderBy: { sentAt: 'desc' } })
      .catch(() => null);
    const name = await this.nameFor(accountId, pn);
    const lastMessageAt = last?.sentAt ?? null;
    const preview = last ? previewOf(this.msgRowToDto(accountId, last)) : null;
    await this.prisma.waChat
      .upsert({
        where: { accountId_jid: { accountId, jid: pn } },
        create: {
          accountId,
          jid: pn,
          name,
          isGroup: false,
          unreadCount: 0,
          lastMessageAt,
          lastMessagePreview: preview,
        },
        update: {
          name: name ?? undefined,
          lastMessageAt: lastMessageAt ?? undefined,
          lastMessagePreview: preview ?? undefined,
        },
      })
      .catch((e) => this.logger.warn(`ensurePnChat: ${e}`));
  }

  private chatRowToDto(
    accountId: string,
    row: {
      jid: string;
      name: string | null;
      isGroup: boolean;
      unreadCount: number;
      lastMessageAt: Date | null;
      lastMessagePreview: string | null;
      pinned: boolean;
      archived: boolean;
      muted: boolean;
      avatarUrl: string | null;
    },
  ): WaChat {
    const s = this.ensureSession(accountId);
    return {
      accountId,
      jid: row.jid,
      name: row.name,
      isGroup: row.isGroup,
      unreadCount: row.unreadCount,
      lastMessageTs: row.lastMessageAt ? row.lastMessageAt.getTime() : null,
      lastMessagePreview: row.lastMessagePreview,
      pinned: row.pinned,
      archived: row.archived,
      muted: row.muted,
      // Bloqué: état mémoire (set re-synchronisé à la connexion + events).
      // Un groupe n'est jamais bloqué (le set ne contient que des JID 1:1).
      // On canonicalise row.jid (un chat peut être stocké sous @lid) pour la
      // même clé que le set, sinon le has() raterait (cf. revue F1, dérive LID).
      blocked: s.blockedJids.has(this.canonicalJid(accountId, row.jid) ?? row.jid),
      // URL backend de la photo de profil (servie à la demande; 404 -> initiales).
      // Le front ajoute le token ?t= pour l'auth.
      avatarUrl: '/api/wa/avatar/' + encodeURIComponent(row.jid),
    };
  }

  private msgRowToDto(
    accountId: string,
    row: {
      id: string;
      chatJid: string;
      fromMe: boolean;
      senderJid: string | null;
      senderName: string | null;
      type: string;
      text: string | null;
      sentAt: Date;
      status: string;
      quotedId: string | null;
      media: unknown;
      reactions: unknown;
      clientId: string | null;
    },
  ): WaMessage {
    const dto: WaMessage = {
      accountId,
      id: row.id,
      chatJid: row.chatJid,
      fromMe: row.fromMe,
      senderJid: row.senderJid,
      senderName: row.senderName,
      type: row.type as WaMessage['type'],
      text: row.text,
      timestamp: row.sentAt.getTime(),
      status: row.status as WaMessageStatus,
      quotedId: row.quotedId,
      media: (row.media as WaMessage['media']) ?? null,
      reactions: (row.reactions as WaReaction[] | null) ?? [],
      clientId: row.clientId,
    };
    // URL backend du média (servie déchiffrée à la demande).
    this.attachMediaUrl(dto);
    return dto;
  }
}
