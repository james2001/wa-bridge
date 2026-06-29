import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
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
  type WaChat,
  type WaConnection,
  type WaMediaItem,
  type WaMessage,
  type WaPresence,
  type WaReaction,
} from '@app/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapWaMessage, previewOf } from './whatsapp.mapper';

// Seuil départageant une durée relative (petite valeur) d'un timestamp epoch ms
// (~1.7e12). Sous ce seuil, muteEndTime est une durée => discussion muette.
const EPOCH_FLOOR_MS = 1_000_000_000_000; // 2001-09-09 en ms

// Renvoie une chaîne non vide nettoyée, ou null. WhatsApp livre souvent ''
// (chaîne vide) pour un nom absent : avec `??` la chaîne vide passerait à
// travers et serait stockée/affichée comme un nom (=> repli sur le JID brut).
const cleanName = (s: unknown): string | null => {
  const t = typeof s === 'string' ? s.trim() : '';
  return t.length > 0 ? t : null;
};

// Événements domaine émis par le service (consommés par la gateway).
export interface WhatsappEvents {
  connection: (conn: WaConnection) => void;
  message: (msg: WaMessage) => void;
  'message-status': (p: {
    id: string;
    chatJid: string;
    status: WaMessageStatus;
  }) => void;
  chats: (chats: WaChat[]) => void;
  'chat-upsert': (chat: WaChat) => void;
  'history-synced': (p: { chatJid: string | null }) => void;
  reaction: (p: {
    chatJid: string;
    messageId: string;
    reactions: WaReaction[];
  }) => void;
  presence: (p: WaPresence) => void;
}

@Injectable()
export class WhatsappService
  extends EventEmitter
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WhatsappService.name);
  private readonly waLogger = pino({ level: 'warn' });
  private sock: WASocket | null = null;
  private authDir = '/data/wa-auth';
  private mediaDir = '/data/media-cache';
  private connecting = false;
  private destroyed = false;
  private connection: WaConnection = {
    state: ConnectionState.CONNECTING,
    qr: null,
    me: null,
  };
  // Carte mémoire LID (<num>@lid) -> numéro (<phone>@s.whatsapp.net).
  // Chargée depuis wa_lid_map au démarrage, enrichie au fil des messages.
  private lidToPn = new Map<string, string>();
  // Vrai pendant une synchro d'historique: évite un flot d'emit 'chats'.
  private historySyncing = false;
  // Garde + throttle du backfill des sujets de groupe (évite le rejeu à chaque
  // reconnexion d'une session qui clignote).
  private groupBackfillRunning = false;
  private groupBackfillAt = 0;

  // --- Limitation des requêtes de photos de profil ---
  // Le front peut demander ~200 avatars d'un coup (liste). On NE DOIT PAS
  // inonder la socket WhatsApp (session fragile + risque de rate-limit).
  private avatarInflight = new Map<
    string,
    Promise<{ buffer: Buffer; mimetype: string }>
  >();
  // Cache négatif: jid -> epoch ms d'expiration (pas de photo connue).
  private avatarNoPhoto = new Map<string, number>();
  private avatarActive = 0;
  private avatarQueue: Array<() => void> = [];
  // Fenêtre de garde après une action locale mute/archive: on ignore l'écho
  // chats.update de WhatsApp qui pourrait réécraser l'état qu'on vient de poser.
  private localMetaGuard = new Map<
    string,
    { archivedUntil: number; mutedUntil: number }
  >();
  private static readonly LOCAL_META_GUARD_MS = 20_000;
  private static readonly AVATAR_MAX_CONCURRENT = 3;
  // 24 h: une entrée "pas de photo" mise à tort (timeout) se répare en 1 jour.
  private static readonly AVATAR_NEG_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
  private static readonly AVATAR_TIMEOUT_MS = 10000;
  // Borne sur les mutations app-state (mute/archive) qui peuvent ne pas répondre.
  private static readonly CHATMODIFY_TIMEOUT_MS = 8000;
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
    this.authDir = this.config.get<string>('waAuthDir') ?? this.authDir;
    this.mediaDir = this.config.get<string>('waMediaDir') ?? this.mediaDir;
    await this.loadLidMap();
    await this.connect();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    try {
      this.sock?.end(undefined);
    } catch {
      /* noop */
    }
  }

  getConnection(): WaConnection {
    return this.connection;
  }

  private setConnection(patch: Partial<WaConnection>): void {
    this.connection = { ...this.connection, ...patch };
    this.emit('connection', this.connection);
  }

  // --- Connexion / cycle de vie ---

  private async connect(): Promise<void> {
    if (this.connecting || this.destroyed) return;
    this.connecting = true;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

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
      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (u) => {
        void this.onConnectionUpdate(u);
      });
      sock.ev.on('messages.upsert', (u) => {
        void this.onMessagesUpsert(u).catch((e) =>
          this.logger.error(`messages.upsert: ${e}`),
        );
      });
      sock.ev.on('messages.update', (updates) => {
        void this.onMessagesUpdate(updates).catch((e) =>
          this.logger.error(`messages.update: ${e}`),
        );
      });
      // Accusés de réception/lecture de NOS messages envoyés.
      sock.ev.on('message-receipt.update', (updates) => {
        void this.onReceiptUpdate(updates).catch((e) =>
          this.logger.error(`message-receipt.update: ${e}`),
        );
      });
      sock.ev.on('messaging-history.set', (h) => {
        void this.onHistorySet(h).catch((e) =>
          this.logger.error(`history.set: ${e}`),
        );
      });
      sock.ev.on('chats.upsert', (chats) => {
        void this.onChatsUpsert(chats).catch((e) =>
          this.logger.error(`chats.upsert: ${e}`),
        );
      });
      // Mise à jour de discussions (ex: non-lus remis à 0 quand tu lis sur le tél).
      sock.ev.on('chats.update', (updates) => {
        void this.onChatsUpdate(updates).catch((e) =>
          this.logger.error(`chats.update: ${e}`),
        );
      });
      sock.ev.on('contacts.upsert', (contacts) => {
        void this.onContactsUpsert(contacts).catch((e) =>
          this.logger.error(`contacts.upsert: ${e}`),
        );
      });
      // Sujets de groupe (création / renommage) -> nom de la discussion.
      sock.ev.on('groups.upsert', (groups) => {
        void this.onGroupsUpsert(groups).catch((e) =>
          this.logger.error(`groups.upsert: ${e}`),
        );
      });
      sock.ev.on('groups.update', (updates) => {
        void this.onGroupsUpsert(updates).catch((e) =>
          this.logger.error(`groups.update: ${e}`),
        );
      });
      // Présence entrante ("en ligne" / "en train d'écrire").
      sock.ev.on('presence.update', (u) => {
        void this.onPresence(u).catch((e) =>
          this.logger.error(`presence.update: ${e}`),
        );
      });
    } finally {
      this.connecting = false;
    }
  }

  private async onConnectionUpdate(
    u: Partial<BaileysConnectionState>,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      this.setConnection({ state: ConnectionState.QR, qr, me: null });
    }

    if (connection === 'open') {
      const me = this.sock?.user;
      this.setConnection({
        state: ConnectionState.OPEN,
        qr: null,
        me: me
          ? { jid: jidNormalizedUser(me.id), name: me.name ?? null }
          : null,
      });
      this.logger.log('WhatsApp connecté');
      void this.backfillGroupSubjects();
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom | undefined)?.output
        ?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        this.logger.warn('Session WhatsApp déconnectée (logged out)');
        this.setConnection({
          state: ConnectionState.LOGGED_OUT,
          qr: null,
          me: null,
        });
        await this.clearAuth();
      } else {
        this.setConnection({ state: ConnectionState.CLOSE, qr: null });
      }
      // Reconnexion (sauf si on a été détruit)
      if (!this.destroyed) {
        setTimeout(() => void this.connect(), 2000);
      }
    }
  }

  private async clearAuth(): Promise<void> {
    // On efface le CONTENU du dossier (pas le dossier lui-même: c'est un point
    // de montage de volume -> rm sur la racine échoue EBUSY et laisse la session
    // révoquée en place, ce qui provoque une boucle de "logged out").
    try {
      const entries = await readdir(this.authDir).catch(() => []);
      await Promise.all(
        entries.map((e) =>
          rm(join(this.authDir, e), { recursive: true, force: true }),
        ),
      );
    } catch (e) {
      this.logger.error(`clearAuth: ${e}`);
    }
  }

  async logout(): Promise<void> {
    try {
      await this.sock?.logout();
    } catch {
      /* noop */
    }
    await this.clearAuth();
    this.setConnection({
      state: ConnectionState.LOGGED_OUT,
      qr: null,
      me: null,
    });
    if (!this.destroyed) setTimeout(() => void this.connect(), 1000);
  }

  // --- Réception ---

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onMessagesUpsert(u: any): Promise<void> {
    const messages = (u?.messages ?? []) as proto.IWebMessageInfo[];
    for (const raw of messages) {
      // Apprend la correspondance LID->numéro portée par la clé (et fusionne).
      await this.learnFromKey(raw.key);
      // Une réaction met à jour le message CIBLE, ne crée pas de bulle.
      if (raw.message?.reactionMessage) {
        await this.handleReaction(raw);
        continue;
      }
      // Suppression "pour tout le monde" (revoke) ou édition: portées par un
      // protocolMessage ciblant un autre message. Traité AVANT le mapping (qui
      // renverrait null pour un protocolMessage) -> placeholder / upsert front.
      if (await this.handleProtocolMessage(raw)) continue;
      const msg = mapWaMessage(raw, this.sock?.user?.id);
      if (!msg) continue;
      // Ignore les Status/Stories et newsletters (pas des conversations).
      if (this.isIgnoredChat(msg.chatJid)) continue;
      // Canonicalise vers le numéro pour qu'un contact = UNE conversation.
      msg.chatJid = (await this.resolvePn(msg.chatJid)) ?? msg.chatJid;
      msg.senderJid = await this.resolvePn(msg.senderJid);
      // Média: extrait le SHA-256 du fichier + conserve le message brut.
      const { rawContent, fileSha256 } = msg.media
        ? this.mediaInfoOf(raw.message)
        : { rawContent: null, fileSha256: null };
      // Dédup double livraison LID: même fichier déjà reçu (id différent) -> on ignore.
      if (msg.media && fileSha256 && (await this.isDuplicateMedia(msg, fileSha256))) {
        continue;
      }
      await this.persistMessage(
        msg,
        msg.media ? { rawMessage: rawContent, fileSha256 } : undefined,
      );
      this.attachMediaUrl(msg);
      const chat = await this.touchChat(msg);
      this.emit('message', msg);
      if (chat) this.emit('chat-upsert', chat);
    }
  }

  // Traite une réaction emoji: met à jour les réactions du message CIBLE.
  // Frontière Baileys -> typage borné à any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleReaction(raw: any): Promise<void> {
    try {
      const rm = raw.message.reactionMessage;
      const target = rm?.key;
      if (!target?.id || !target?.remoteJid) return;
      const targetId: string = target.id;
      const chatJid =
        (await this.resolvePn(target.remoteJid)) ?? target.remoteJid;
      const emoji: string = (rm.text ?? '').trim(); // '' => retrait
      const fromMe = Boolean(raw.key?.fromMe);
      let senderJid: string | null = fromMe
        ? this.sock?.user?.id
          ? jidNormalizedUser(this.sock.user.id)
          : null
        : (raw.key?.participant ?? raw.key?.remoteJid ?? null);
      senderJid = await this.resolvePn(senderJid);

      // Charge le message cible (on ne réagit pas à un message inconnu).
      const msg = await this.prisma.waMessage
        .findUnique({ where: { chatJid_id: { chatJid, id: targetId } } })
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
          where: { chatJid_id: { chatJid, id: targetId } },
          data: { reactions: reactions as unknown as Prisma.InputJsonValue },
        })
        .catch(() => undefined);

      this.emit('reaction', { chatJid, messageId: targetId, reactions });
    } catch (e) {
      this.logger.error(`handleReaction: ${e}`);
    }
  }

  // Suppression (revoke) / édition d'un message: un protocolMessage CIBLE un
  // autre message via protocolMessage.key. Retourne true si l'événement a été
  // consommé (ne PAS créer de bulle). Frontière Baileys -> typage borné à any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleProtocolMessage(raw: any): Promise<boolean> {
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
      const chatJid = (await this.resolvePn(rawJid)) ?? rawJid;

      if (protocol.type === Type.REVOKE) {
        await this.applyRevoke(chatJid, targetId);
        return true;
      }
      if (protocol.type === Type.MESSAGE_EDIT) {
        const newText = this.extractEditedText(protocol.editedMessage);
        if (newText !== null) await this.applyEdit(chatJid, targetId, newText);
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
  private async applyRevoke(chatJid: string, targetId: string): Promise<void> {
    const row = await this.prisma.waMessage
      .update({
        where: { chatJid_id: { chatJid, id: targetId } },
        data: {
          text: '🚫 Ce message a été supprimé',
          type: 'system',
          media: Prisma.DbNull,
        },
      })
      .catch(() => null); // message cible inconnu -> on ignore
    if (row) this.emit('message', this.msgRowToDto(row));
  }

  // Applique l'édition d'un message (nouveau texte) puis réémet pour upsert front.
  private async applyEdit(
    chatJid: string,
    targetId: string,
    text: string,
  ): Promise<void> {
    const row = await this.prisma.waMessage
      .update({
        where: { chatJid_id: { chatJid, id: targetId } },
        data: { text, editedAt: new Date() },
      })
      .catch(() => null);
    if (row) this.emit('message', this.msgRowToDto(row));
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onMessagesUpdate(updates: any[]): Promise<void> {
    for (const { key, update } of updates) {
      const rawJid: string | undefined = key?.remoteJid ?? undefined;
      const id: string | undefined = key?.id ?? undefined;
      if (!rawJid || !id) continue;
      if (update.status === undefined || update.status === null) continue;
      // Le message est stocké sous le JID canonique (téléphone) ; l'accusé peut
      // arriver sous le JID @lid -> on canonicalise pour retrouver le message.
      const chatJid = (await this.resolvePn(rawJid)) ?? rawJid;
      const status = this.mapNumericStatus(update.status);
      await this.prisma.waMessage
        .update({
          where: { chatJid_id: { chatJid, id } },
          data: { status },
        })
        .catch(() => undefined); // message pas encore en cache
      this.emit('message-status', { id, chatJid, status });
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onReceiptUpdate(updates: any[]): Promise<void> {
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
      const chatJid = (await this.resolvePn(rawJid)) ?? rawJid;
      await this.prisma.waMessage
        .update({
          where: { chatJid_id: { chatJid, id } },
          data: { status },
        })
        .catch(() => undefined);
      this.emit('message-status', { id, chatJid, status });
    }
  }

  // Types Baileys volatils selon la version -> on borne le typage à la frontière.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onHistorySet(h: any): Promise<void> {
    // Contacts: name = carnet d'adresses (ce que TU as enregistré), pushName =
    // ce que le contact s'est donné. On découple strictement (cf. onContactsUpsert).
    for (const c of h.contacts ?? []) {
      await this.upsertContact(c);
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
      const name = await this.chatDisplayName(jid, ch.name);
      // Archive/mute portés par l'historique (app-state) — sinon on les perdait.
      const meta = this.chatMetaOf(ch);
      await this.prisma.waChat
        .upsert({
          where: { jid },
          create: {
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
      .map((raw) => ({ raw, msg: mapWaMessage(raw, this.sock?.user?.id) }))
      .filter(
        (p): p is { raw: proto.IWebMessageInfo; msg: WaMessage } =>
          p.msg !== null,
      )
      .filter((p) => !this.isIgnoredChat(p.msg.chatJid));

    // Résout (une seule fois) chaque LID distinct du lot via l'API native 7.x,
    // ce qui peuple le cache lidToPn. On évite le flot d'emit pendant la synchro.
    this.historySyncing = true;
    const lids = new Set<string>();
    for (const { msg } of pairs) {
      if (msg.chatJid && isLidUser(msg.chatJid)) lids.add(msg.chatJid);
      if (msg.senderJid && isLidUser(msg.senderJid)) lids.add(msg.senderJid);
    }
    for (const lid of lids) await this.resolvePn(lid);
    this.historySyncing = false;

    // Canonicalise via le cache (synchrone) avant insertion + dédup média.
    const seenSha = new Set<string>(); // doublons LID au sein du même lot
    const rows: Prisma.WaMessageCreateManyInput[] = [];
    for (const { raw, msg } of pairs) {
      msg.chatJid = this.canonicalJid(msg.chatJid) ?? msg.chatJid;
      msg.senderJid = this.canonicalJid(msg.senderJid);
      if (msg.media) {
        const { rawContent, fileSha256 } = this.mediaInfoOf(raw.message);
        if (fileSha256) {
          const key = `${msg.chatJid}|${fileSha256}`;
          if (seenSha.has(key)) continue; // doublon dans ce lot
          if (await this.isDuplicateMedia(msg, fileSha256)) continue; // déjà en DB
          seenSha.add(key);
        }
        rows.push(this.toMessageRow(msg, { rawMessage: rawContent, fileSha256 }));
      } else {
        rows.push(this.toMessageRow(msg));
      }
    }
    for (let i = 0; i < rows.length; i += 500) {
      await this.prisma.waMessage
        .createMany({ data: rows.slice(i, i + 500), skipDuplicates: true })
        .catch(() => undefined);
    }

    const chats = await this.listChats();
    this.emit('chats', chats);
    this.emit('history-synced', { chatJid: null });
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onChatsUpsert(chats: any[]): Promise<void> {
    for (const ch of chats) {
      if (this.isIgnoredChat(ch.id)) continue;
      const name = await this.chatDisplayName(ch.id, ch.name);
      const meta = this.chatMetaOf(ch);
      const row = await this.prisma.waChat
        .upsert({
          where: { jid: ch.id },
          create: {
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
      if (row) this.emit('chat-upsert', this.chatRowToDto(row));
    }
  }

  // Mises à jour de discussions (non-lus, nom...). Sert notamment à refléter
  // dans le web le fait que tu as lu une conversation depuis ton téléphone.
  // Mises à jour de discussions. Le `unreadCount` de WhatsApp y est AUTORITAIRE
  // (reflète l'état multi-device, dont les lectures sur le téléphone).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onChatsUpdate(updates: any[]): Promise<void> {
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
      const jid = (await this.resolvePn(ch.id)) ?? ch.id;
      const subject = cleanName(ch.name);
      // Si on vient de poser archive/mute localement, ignorer l'écho WhatsApp
      // (sinon il réécrase notre état avec une valeur parfois incohérente).
      if (meta.archived !== undefined && this.isMetaGuarded(jid, 'archived')) {
        meta.archived = undefined;
      }
      if (meta.muted !== undefined && this.isMetaGuarded(jid, 'muted')) {
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
      const name = await this.chatDisplayName(jid, ch.name);
      const row = await this.prisma.waChat
        .upsert({
          where: { jid },
          create: {
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
      if (row) this.emit('chat-upsert', this.chatRowToDto(row));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onContactsUpsert(contacts: any[]): Promise<void> {
    for (const c of contacts) {
      await this.upsertContact(c);
    }
  }

  // Découple STRICTEMENT les deux noms: `name` = carnet d'adresses (c.name),
  // `pushName` = ce que le contact s'est donné (c.notify). On n'écrit jamais
  // l'un depuis l'autre, sinon un contacts.upsert "notify seul" écraserait le
  // nom du carnet par le pushName (les `undefined` ne touchent pas la colonne).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async upsertContact(c: any): Promise<void> {
    if (!c?.id) return;
    const carnet = cleanName(c.name);
    const push = cleanName(c.notify);
    await this.prisma.waContact
      .upsert({
        where: { jid: c.id },
        create: {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onGroupsUpsert(groups: any[]): Promise<void> {
    for (const g of groups) {
      const subject = cleanName(g?.subject);
      if (!g?.id || !subject || this.isIgnoredChat(g.id)) continue;
      // upsert (pas update): un groupe tout neuf (création/jonction) n'a pas
      // encore de ligne de discussion -> il faut la créer, pas la rater.
      const row = await this.prisma.waChat
        .upsert({
          where: { jid: g.id },
          create: {
            jid: g.id,
            name: subject,
            isGroup: isJidGroup(g.id) ?? true,
            unreadCount: 0,
          },
          update: { name: subject },
        })
        .catch(() => null);
      if (row) this.emit('chat-upsert', this.chatRowToDto(row));
    }
  }

  // Récupère le sujet de TOUS les groupes participés (1 requête) et renseigne le
  // nom des discussions de groupe (les événements de chat ne portent pas
  // toujours le sujet -> sinon affichage du JID brut). Une fois par ouverture.
  private async backfillGroupSubjects(): Promise<void> {
    if (!this.sock || this.connection.state !== ConnectionState.OPEN) return;
    // Garde anti-concurrence + throttle (pas de rejeu sur reconnexions rapprochées).
    if (this.groupBackfillRunning || Date.now() - this.groupBackfillAt < 30_000) {
      return;
    }
    this.groupBackfillRunning = true;
    this.groupBackfillAt = Date.now();
    try {
      const all = await this.withTimeout(
        this.sock.groupFetchAllParticipating(),
        WhatsappService.CHATMODIFY_TIMEOUT_MS,
      );
      // État courant des groupes (1 requête) -> on n'écrit/émet que sur changement.
      const existing = await this.prisma.waChat
        .findMany({ where: { isGroup: true }, select: { jid: true, name: true } })
        .catch(() => [] as { jid: string; name: string | null }[]);
      const current = new Map(existing.map((r) => [r.jid, r.name]));
      let fixed = 0;
      for (const [jid, meta] of Object.entries(all ?? {})) {
        if (!current.has(jid)) continue; // pas (encore) une discussion -> onGroupsUpsert/messages s'en chargent
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const display =
          cleanName((meta as any)?.subject) ??
          (await this.groupNameFromParticipants(meta));
        if (!display || current.get(jid) === display) continue; // inchangé
        const row = await this.prisma.waChat
          .update({ where: { jid }, data: { name: display } })
          .catch(() => null);
        if (row) {
          fixed++;
          this.emit('chat-upsert', this.chatRowToDto(row));
        }
      }
      if (fixed > 0) {
        this.logger.log(`Sujets de groupe synchronisés (${fixed} discussion(s))`);
      }
    } catch (e) {
      this.logger.warn(`backfillGroupSubjects: ${e}`);
    } finally {
      this.groupBackfillRunning = false;
    }
  }

  // Groupe SANS sujet -> nom à la WhatsApp: noms des participants (hors soi),
  // les 3 premiers puis "+N". Repli sur le numéro si le nom est inconnu.
  private async groupNameFromParticipants(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meta: any,
  ): Promise<string | null> {
    const parts: unknown[] = Array.isArray(meta?.participants)
      ? meta.participants
      : [];
    if (!parts.length) return null;
    // Identités de soi (numéro normalisé/canonique + LID) pour s'exclure de
    // façon fiable, les participants étant souvent adressés en @lid.
    const u = this.sock?.user;
    const selfSet = new Set<string>();
    if (u?.id) {
      selfSet.add(jidNormalizedUser(u.id));
      const c = this.canonicalJid(u.id);
      if (c) selfSet.add(c);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const selfLid = (u as any)?.lid;
    if (typeof selfLid === 'string') selfSet.add(jidNormalizedUser(selfLid));
    const others = parts.filter((p) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = this.canonicalJid((p as any)?.id);
      return !!j && !selfSet.has(j);
    });
    const names: string[] = [];
    for (const p of others.slice(0, 3)) {
      // resolvePn() résout activement le LID -> numéro (API native) ; on tombe
      // ensuite sur le nom du carnet, sinon le numéro (plutôt qu'un LID brut).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jid = (await this.resolvePn((p as any)?.id)) ?? this.canonicalJid((p as any)?.id);
      if (!jid) continue;
      const n = (await this.nameFor(jid)) ?? jid.split('@')[0].split(':')[0];
      if (n) names.push(n);
    }
    if (!names.length) return null;
    const extra = others.length - names.length;
    return extra > 0 ? `${names.join(', ')} +${extra}` : names.join(', ');
  }

  // --- Envoi / actions ---

  async sendText(
    chatJid: string,
    text: string,
    clientId: string,
  ): Promise<WaMessage> {
    if (!this.sock || this.connection.state !== ConnectionState.OPEN) {
      throw new Error('WhatsApp non connecté');
    }
    // Le numéro @s.whatsapp.net est toujours une cible d'envoi valide.
    const target = (await this.resolvePn(chatJid)) ?? chatJid;
    const sent = await this.sock.sendMessage(target, { text });
    const msg = sent ? mapWaMessage(sent, this.sock.user?.id) : null;
    if (!msg) throw new Error("Échec de l'envoi");
    msg.chatJid = this.canonicalJid(msg.chatJid) ?? msg.chatJid;
    msg.senderJid = this.canonicalJid(msg.senderJid);
    msg.clientId = clientId;
    if (!msg.text) msg.text = text;
    // L'envoi a réussi côté serveur WhatsApp -> au moins "envoyé" (✓),
    // les accusés delivered/read suivront via message-receipt.update.
    if (msg.status === WaMessageStatus.PENDING) msg.status = WaMessageStatus.SENT;
    await this.persistMessage(msg);
    const chat = await this.touchChat(msg);
    this.emit('message', msg);
    if (chat) this.emit('chat-upsert', chat);
    return msg;
  }

  // Envoi d'un média (image/vidéo/audio/document) depuis le pont vers WhatsApp.
  async sendMedia(
    chatJid: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
    caption?: string,
  ): Promise<WaMessage> {
    if (!this.sock || this.connection.state !== ConnectionState.OPEN) {
      throw new Error('WhatsApp non connecté');
    }
    const target = (await this.resolvePn(chatJid)) ?? chatJid;

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
    const sent = await this.sock.sendMessage(target, content as any);
    const msg = sent ? mapWaMessage(sent, this.sock.user?.id) : null;
    if (!msg) throw new Error("Échec de l'envoi du média");
    msg.chatJid = this.canonicalJid(msg.chatJid) ?? msg.chatJid;
    msg.senderJid = this.canonicalJid(msg.senderJid);

    // Message brut + SHA-256 du fichier (réutilise l'extraction média existante).
    const { rawContent, fileSha256 } = this.mediaInfoOf(sent?.message);

    // L'envoi a réussi côté serveur WhatsApp -> au moins "envoyé" (✓).
    if (msg.status === WaMessageStatus.PENDING) msg.status = WaMessageStatus.SENT;
    await this.persistMessage(msg, { rawMessage: rawContent, fileSha256 });

    // Écrit le buffer dans le cache média (même nom de fichier que getMedia)
    // pour un affichage immédiat sans re-télécharger. Ne doit pas faire échouer
    // l'envoi si le cache échoue.
    try {
      const safe = msg.id.replace(/[^a-zA-Z0-9]/g, '_');
      await mkdir(this.mediaDir, { recursive: true });
      await writeFile(join(this.mediaDir, safe), file.buffer);
    } catch (e) {
      this.logger.warn(`sendMedia cache ${msg.id}: ${e}`);
    }

    this.attachMediaUrl(msg);
    const chat = await this.touchChat(msg);
    this.emit('message', msg);
    if (chat) this.emit('chat-upsert', chat);
    return msg;
  }

  async markRead(chatJid: string): Promise<void> {
    if (!this.sock) return;
    // Canonicalise vers le numéro pour le stockage local.
    const jid = (await this.resolvePn(chatJid)) ?? chatJid;
    const recent = await this.prisma.waMessage.findMany({
      where: { chatJid: jid, fromMe: false },
      orderBy: { sentAt: 'desc' },
      take: 30,
    });
    if (recent.length > 0) {
      const group = isJidGroup(jid) ?? false;
      // WhatsApp adresse souvent ces chats par LID: l'accusé de lecture doit
      // cibler le LID, sinon il est ignoré (le tél/l'expéditeur ne voient rien).
      const readJid = group ? jid : ((await this.getLid(jid)) ?? jid);
      const keys = recent.map((r) => ({
        remoteJid: readJid,
        id: r.id,
        fromMe: false,
        ...(group ? { participant: r.senderJid ?? undefined } : {}),
      }));
      try {
        await this.sock.readMessages(keys);
        this.logger.log(`markRead: ${keys.length} lu(s) sur ${readJid}`);
      } catch (e) {
        this.logger.warn(`markRead readMessages: ${e}`);
      }
    }
    // Remet le compteur à 0 ET notifie le front (sinon le badge reste affiché).
    const row = await this.prisma.waChat
      .update({ where: { jid }, data: { unreadCount: 0 } })
      .catch(() => null);
    if (row) this.emit('chat-upsert', this.chatRowToDto(row));
  }

  // Archive / désarchive une discussion. WhatsApp exige le dernier message du
  // chat (clé + timestamp) pour cibler l'opération chatModify. On met TOUJOURS
  // à jour la colonne locale + on notifie le front, même si l'appel WhatsApp
  // échoue (ne jamais casser la connexion).
  // Marque un champ comme posé localement (garde contre l'écho WhatsApp).
  private guardLocalMeta(jid: string, field: 'archived' | 'muted'): void {
    const until = Date.now() + WhatsappService.LOCAL_META_GUARD_MS;
    const cur = this.localMetaGuard.get(jid) ?? {
      archivedUntil: 0,
      mutedUntil: 0,
    };
    if (field === 'archived') cur.archivedUntil = until;
    else cur.mutedUntil = until;
    this.localMetaGuard.set(jid, cur);
  }

  private isMetaGuarded(jid: string, field: 'archived' | 'muted'): boolean {
    const g = this.localMetaGuard.get(jid);
    if (!g) return false;
    const until = field === 'archived' ? g.archivedUntil : g.mutedUntil;
    return until > Date.now();
  }

  async setArchived(chatJid: string, archived: boolean): Promise<void> {
    const jid = (await this.resolvePn(chatJid)) ?? chatJid;
    this.guardLocalMeta(jid, 'archived');
    // 1) État local AUTORITAIRE: on met à jour la colonne + on notifie le front
    //    immédiatement (le pont reflète l'action sans dépendre de WhatsApp).
    const row = await this.prisma.waChat
      .update({ where: { jid }, data: { archived } })
      .catch(() => null);
    if (row) this.emit('chat-upsert', this.chatRowToDto(row));
    // 2) Synchro WhatsApp en best-effort (NE PAS bloquer/awaiter: chatModify
    //    peut traîner ou ne jamais répondre selon l'état app-state).
    const last = await this.prisma.waMessage
      .findFirst({ where: { chatJid: jid }, orderBy: { sentAt: 'desc' } })
      .catch(() => null);
    const lastMessages = last
      ? [
          {
            key: { remoteJid: jid, id: last.id, fromMe: last.fromMe },
            messageTimestamp: Math.floor(last.sentAt.getTime() / 1000),
          },
        ]
      : [];
    void this.syncChatModify(jid, { archive: archived, lastMessages }, 'archive');
  }

  // Active / désactive le mode silencieux (mute) d'une discussion. WhatsApp
  // attend une durée en ms (8h) pour muter, null pour réactiver le son.
  async setMuted(chatJid: string, muted: boolean): Promise<void> {
    const jid = (await this.resolvePn(chatJid)) ?? chatJid;
    this.guardLocalMeta(jid, 'muted');
    // 1) État local autoritaire d'abord (cf. setArchived).
    const row = await this.prisma.waChat
      .update({ where: { jid }, data: { muted } })
      .catch(() => null);
    if (row) this.emit('chat-upsert', this.chatRowToDto(row));
    // 2) Synchro WhatsApp best-effort, sans bloquer.
    void this.syncChatModify(
      jid,
      { mute: muted ? 8 * 60 * 60 * 1000 : null },
      'mute',
    );
  }

  // Pousse une mutation app-state vers WhatsApp sans jamais bloquer l'appelant.
  // chatModify peut ne pas répondre: on borne par un timeout et on logge.
  private syncChatModify(
    jid: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod: any,
    label: string,
  ): void {
    if (!this.sock || this.connection.state !== ConnectionState.OPEN) return;
    this.withTimeout(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.sock as any).chatModify(mod, jid) as Promise<unknown>,
      WhatsappService.CHATMODIFY_TIMEOUT_MS,
    )
      .then(() => this.logger.log(`chatModify(${label}) OK ${jid}`))
      .catch((e) => this.logger.warn(`chatModify(${label}) ${jid}: ${e}`));
  }

  // Photo de profil d'un contact/groupe. Cache disque (fichier 'avatar_<jid>').
  // 404 (NotFoundException) si pas de photo -> le front affiche les initiales.
  // Protégé contre l'avalanche de requêtes: cache disque + cache négatif +
  // déduplication des requêtes en vol + limite de concurrence sur la socket.
  async getAvatar(jid: string): Promise<{ buffer: Buffer; mimetype: string }> {
    const safe = 'avatar_' + jid.replace(/[^a-zA-Z0-9]/g, '_');
    const filePath = join(this.mediaDir, safe);

    // 1) Cache disque (photo déjà téléchargée) -> réponse immédiate.
    await mkdir(this.mediaDir, { recursive: true }).catch(() => undefined);
    const cached = await readFile(filePath).catch(() => null);
    if (cached) return { buffer: cached, mimetype: 'image/jpeg' };

    // 2) Cache négatif mémoire: on sait déjà qu'il n'y a pas de photo -> 404.
    const negUntil = this.avatarNoPhoto.get(jid);
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
      this.avatarNoPhoto.set(jid, markerStat.mtimeMs + WhatsappService.AVATAR_NEG_TTL_MS);
      throw new NotFoundException('Pas de photo de profil');
    }

    // 3) Déduplication: si une requête est déjà en vol pour ce jid, la partager.
    const existing = this.avatarInflight.get(jid);
    if (existing) return existing;

    const task = this.fetchAvatar(jid, filePath).finally(() => {
      this.avatarInflight.delete(jid);
    });
    this.avatarInflight.set(jid, task);
    return task;
  }

  private async fetchAvatar(
    jid: string,
    filePath: string,
  ): Promise<{ buffer: Buffer; mimetype: string }> {
    // Connexion fermée = échec TRANSITOIRE: ne JAMAIS persister "pas de photo"
    // (sinon un avatar valide reste introuvable 24 h après une reconnexion).
    const sock = this.sock;
    if (!sock || this.connection.state !== ConnectionState.OPEN) {
      this.markTransientNoAvatar(jid);
      throw new NotFoundException('WhatsApp non connecté');
    }
    const release = await this.acquireAvatarSlot();
    try {
      let url: string | null | undefined;
      try {
        url = await this.profilePicUrl(sock, jid);
      } catch (e) {
        // 404 / photo privée = vraiment pas de photo (cache négatif long).
        // Timeout / connexion / autre = transitoire (réessai, pas de marqueur).
        if (this.isNoProfilePicError(e)) this.markNoAvatar(jid, filePath);
        else this.markTransientNoAvatar(jid);
        throw new NotFoundException('Pas de photo de profil');
      }
      if (!url) {
        // Réponse sans URL = pas de photo de profil.
        this.markNoAvatar(jid, filePath);
        throw new NotFoundException('Pas de photo de profil');
      }
      // URL obtenue (une photo EXISTE) ; échec de téléchargement = transitoire.
      const res = await this.withTimeout(
        fetch(url),
        WhatsappService.AVATAR_TIMEOUT_MS,
      ).catch(() => null);
      if (!res || !res.ok) {
        this.markTransientNoAvatar(jid);
        throw new NotFoundException('Photo indisponible (transitoire)');
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(filePath, buf).catch(() => undefined);
      // Photo trouvée: purge un éventuel marqueur négatif obsolète.
      await unlink(filePath + '.none').catch(() => undefined);
      this.avatarNoPhoto.delete(jid);
      return {
        buffer: buf,
        mimetype: res.headers.get('content-type') ?? 'image/jpeg',
      };
    } catch (e) {
      // Erreur résiduelle inattendue (lecture du flux…) -> transitoire (pas 500).
      if (e instanceof NotFoundException) throw e;
      this.markTransientNoAvatar(jid);
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
  private markNoAvatar(jid: string, filePath: string): void {
    this.avatarNoPhoto.set(jid, Date.now() + WhatsappService.AVATAR_NEG_TTL_MS);
    // Marqueur disque vide: la fraîcheur est lue via le mtime du fichier.
    writeFile(filePath + '.none', '').catch(() => undefined);
  }

  // Échec TRANSITOIRE (déconnexion / timeout / CDN): on évite seulement le
  // martèlement ~1 min, SANS marqueur disque ni TTL long -> réessai auto ensuite.
  private markTransientNoAvatar(jid: string): void {
    this.avatarNoPhoto.set(jid, Date.now() + 60_000);
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
  private async acquireAvatarSlot(): Promise<() => void> {
    await new Promise<void>((resolve) => {
      if (this.avatarActive < WhatsappService.AVATAR_MAX_CONCURRENT) {
        this.avatarActive++;
        resolve();
      } else {
        this.avatarQueue.push(() => {
          this.avatarActive++;
          resolve();
        });
      }
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.avatarActive--;
      const next = this.avatarQueue.shift();
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
  private async getLid(pnJid: string): Promise<string | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lm = (this.sock as any)?.signalRepository?.lidMapping;
      const lid: string | null | undefined = lm?.getLIDForPN
        ? await lm.getLIDForPN(pnJid)
        : null;
      return lid && isLidUser(lid) ? lid : null;
    } catch {
      return null;
    }
  }

  async setTyping(chatJid: string, typing: boolean): Promise<void> {
    if (!this.sock || this.connection.state !== ConnectionState.OPEN) return;
    await this.sock
      .sendPresenceUpdate(typing ? 'composing' : 'paused', chatJid)
      .catch(() => undefined);
  }

  // S'abonne à la présence d'un contact. WhatsApp adresse par LID -> on tente
  // le LID, sinon le jid tel quel. Ne doit jamais casser la connexion.
  async subscribePresence(chatJid: string): Promise<void> {
    if (!this.sock || this.connection.state !== ConnectionState.OPEN) return;
    try {
      const target = (await this.getLid(chatJid)) ?? chatJid;
      await this.sock.presenceSubscribe(target);
    } catch (e) {
      this.logger.warn(`subscribePresence ${chatJid}: ${e}`);
    }
  }

  // Présence entrante. Forme 7.x:
  //   { id: chatJid, presences: { [participantJid]: { lastKnownPresence, lastSeen? } } }
  // En DM, on prend la 1ère entrée (l'interlocuteur).
  // Frontière Baileys -> typage borné à any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onPresence(u: any): Promise<void> {
    try {
      const id: string | undefined = u?.id;
      if (!id) return;
      const presences = u?.presences ?? {};
      const first = Object.values(presences)[0] as
        | { lastKnownPresence?: string | null }
        | undefined;
      const presence: WaPresence = {
        jid: (await this.resolvePn(id)) ?? id,
        kind: this.mapPresence(first?.lastKnownPresence),
        at: Date.now(),
      };
      this.emit('presence', presence);
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

  async listChats(): Promise<WaChat[]> {
    const rows = await this.prisma.waChat.findMany({
      orderBy: [{ lastMessageAt: 'desc' }],
      take: 500,
    });
    return rows
      .filter((r) => !this.isIgnoredChat(r.jid))
      .filter((r) => !this.isPlaceholderChat(r))
      .map((r) => this.chatRowToDto(r));
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
    chatJid: string,
    before: number | null,
    limit: number,
  ): Promise<{ messages: WaMessage[]; hasMore: boolean; nextBefore: number | null }> {
    const rows = await this.prisma.waMessage.findMany({
      where: {
        chatJid,
        ...(before ? { sentAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { sentAt: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return {
      messages: page.map((r) => this.msgRowToDto(r)),
      hasMore,
      nextBefore: hasMore ? page[0]?.sentAt.getTime() ?? null : null,
    };
  }

  // Galerie média d'une discussion: TOUS les médias, récents d'abord. On
  // canonicalise le JID (numéro) comme les autres méthodes, on filtre les
  // messages porteurs d'un média, puis on réutilise msgRowToDto (qui pose
  // media + l'url via attachMediaUrl) avant de projeter sur WaMediaItem. Les
  // lignes sans média réel (ex: message supprimé) sont ignorées.
  async listChatMedia(chatJid: string): Promise<WaMediaItem[]> {
    const jid = (await this.resolvePn(chatJid)) ?? chatJid;
    const rows = await this.prisma.waMessage.findMany({
      where: { chatJid: jid, type: { in: [...WhatsappService.MEDIA_TYPES] } },
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
      const dto = this.msgRowToDto(row);
      const media = dto.media;
      if (!media) continue; // pas de média réel -> ignoré
      items.push({
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

  // --- Persistance / helpers ---

  // Champs média facultatifs (présents uniquement pour les messages média).
  private toMessageRow(
    m: WaMessage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extra?: { rawMessage?: any; fileSha256?: string | null },
  ) {
    return {
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
    m: WaMessage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extra?: { rawMessage?: any; fileSha256?: string | null },
  ): Promise<void> {
    const row = this.toMessageRow(m, extra);
    await this.prisma.waMessage
      .upsert({
        where: { chatJid_id: { chatJid: m.chatJid, id: m.id } },
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
    m: WaMessage,
    fileSha256: string,
  ): Promise<boolean> {
    const existing = await this.prisma.waMessage
      .findFirst({
        where: { chatJid: m.chatJid, fileSha256, id: { not: m.id } },
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
    chatJid: string,
    id: string,
  ): Promise<{ buffer: Buffer; mimetype: string; fileName: string | null }> {
    const row = await this.prisma.waMessage
      .findUnique({ where: { chatJid_id: { chatJid, id } } })
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
    const filePath = join(this.mediaDir, safe);
    try {
      await mkdir(this.mediaDir, { recursive: true });
      const cached = await readFile(filePath).catch(() => null);
      if (cached) return { buffer: cached, mimetype, fileName };

      if (!this.sock) throw new Error('WhatsApp non connecté');
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
          reuploadRequest: this.sock.updateMediaMessage,
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

  private async touchChat(m: WaMessage): Promise<WaChat | null> {
    const name = await this.nameFor(m.chatJid);
    const at = new Date(m.timestamp || Date.now());
    const preview = previewOf(m);
    const row = await this.prisma.waChat
      .upsert({
        where: { jid: m.chatJid },
        create: {
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
    return row ? this.chatRowToDto(row) : null;
  }

  private async nameFor(jid: string): Promise<string | null> {
    if (isJidGroup(jid)) return null;
    const c = await this.prisma.waContact
      .findUnique({ where: { jid } })
      .catch(() => null);
    // Carnet d'adresses (name) d'abord, pushName en repli.
    return cleanName(c?.name) ?? cleanName(c?.pushName) ?? null;
  }

  // Nom à afficher pour une discussion. Groupe -> sujet (ch.name de Baileys).
  // 1:1 -> on PRÉFÈRE le carnet d'adresses (nameFor) au ch.name de Baileys, qui
  // peut être un pushName et masquerait le nom que tu as enregistré.
  private async chatDisplayName(
    jid: string,
    rawChatName: unknown,
  ): Promise<string | null> {
    const subject = cleanName(rawChatName);
    if (isJidGroup(jid)) return subject;
    return (await this.nameFor(jid)) ?? subject;
  }

  // --- LID / canonicalisation ---

  // Charge la table wa_lid_map en mémoire au démarrage.
  private async loadLidMap(): Promise<void> {
    try {
      const rows = await this.prisma.waLidMap.findMany();
      for (const r of rows) this.lidToPn.set(r.lid, r.pn);
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

  private canonicalJid(jid: string | null | undefined): string | null {
    if (!jid) return null;
    const norm = this.normJid(jid);
    if (!isLidUser(norm)) return norm;
    return this.lidToPn.get(norm) ?? this.lidToPn.get(jid) ?? norm;
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
    jid: string | null | undefined,
  ): Promise<string | null> {
    if (!jid) return null;
    const norm = this.normJid(jid);
    if (!isLidUser(norm)) return norm;
    const cached = this.lidToPn.get(norm);
    if (cached) return cached;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lm = (this.sock as any)?.signalRepository?.lidMapping;
      const pn: string | null | undefined = lm?.getPNForLID
        ? await lm.getPNForLID(norm)
        : null;
      if (pn && pn.endsWith('@s.whatsapp.net')) {
        await this.learnLid(norm, pn);
        return this.normJid(pn);
      }
    } catch {
      /* noop */
    }
    return norm;
  }

  // Apprend les correspondances LID->numéro portées par une clé de message.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async learnFromKey(key: any): Promise<void> {
    try {
      if (!key) return;
      const remoteJid: string | undefined = key.remoteJid ?? undefined;
      const participant: string | undefined = key.participant ?? undefined;

      // Cas où les deux identités sont fournies ensemble.
      if (key.senderLid && key.senderPn) {
        await this.learnLid(key.senderLid, key.senderPn);
      }
      if (participant && key.participantPn) {
        await this.learnLid(participant, key.participantPn);
      }
      // DM: remoteJid est le LID, senderPn fournit le numéro.
      if (remoteJid && isLidUser(remoteJid) && key.senderPn) {
        await this.learnLid(remoteJid, key.senderPn);
      }
      // DM: remoteJid est le numéro, senderLid fournit le LID.
      if (
        remoteJid &&
        remoteJid.endsWith('@s.whatsapp.net') &&
        key.senderLid
      ) {
        await this.learnLid(key.senderLid, remoteJid);
      }
      // Groupe: participant est le LID, participantPn fournit le numéro.
      if (participant && isLidUser(participant) && key.participantPn) {
        await this.learnLid(participant, key.participantPn);
      }
    } catch (e) {
      this.logger.warn(`learnFromKey: ${e}`);
    }
  }

  // Enregistre une correspondance LID->numéro (mémoire + DB) et fusionne
  // rétroactivement le chat @lid existant dans le chat numéro.
  private async learnLid(lidRaw: string, pnRaw: string): Promise<void> {
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
    if (this.lidToPn.get(lid) === pn) return; // déjà connu

    this.lidToPn.set(lid, pn);

    try {
      await this.prisma.waLidMap.upsert({
        where: { lid },
        create: { lid, pn },
        update: { pn },
      });
    } catch (e) {
      this.logger.warn(`learnLid upsert: ${e}`);
    }

    // Fusion rétroactive — ne doit jamais casser la connexion WhatsApp.
    try {
      await this.mergeLidChat(lid, pn);
      // Pendant la synchro d'historique, on évite un flot d'emit (un seul à la fin).
      if (!this.historySyncing) this.emit('chats', await this.listChats());
    } catch (e) {
      this.logger.warn(`mergeLidChat ${lid} -> ${pn}: ${e}`);
    }
  }

  // Déplace messages + chat du JID @lid vers le numéro, en gérant la collision
  // de clé primaire (même id présent sous les 2 jids).
  private async mergeLidChat(lid: string, pn: string): Promise<void> {
    // a. Réaffecte au numéro les messages absents (par id) sous le numéro.
    await this.prisma.$executeRaw`
      UPDATE "wa_messages" SET "chat_jid" = ${pn}
      WHERE "chat_jid" = ${lid}
        AND NOT EXISTS (
          SELECT 1 FROM "wa_messages" w
          WHERE w."chat_jid" = ${pn} AND w."id" = "wa_messages"."id"
        )`;
    // b. Supprime les doublons restés sous le lid.
    await this.prisma
      .$executeRaw`DELETE FROM "wa_messages" WHERE "chat_jid" = ${lid}`;
    // c. Corrige l'expéditeur (y compris dans les groupes).
    await this.prisma
      .$executeRaw`UPDATE "wa_messages" SET "sender_jid" = ${pn} WHERE "sender_jid" = ${lid}`;
    // d. Supprime le chat lid.
    await this.prisma.$executeRaw`DELETE FROM "wa_chats" WHERE "jid" = ${lid}`;
    // e. Recalcule / assure le chat numéro à partir de son dernier message.
    await this.ensurePnChat(pn);
  }

  // Assure l'existence du chat numéro et recale aperçu/horodatage sur le dernier
  // message connu pour ce numéro.
  private async ensurePnChat(pn: string): Promise<void> {
    const last = await this.prisma.waMessage
      .findFirst({ where: { chatJid: pn }, orderBy: { sentAt: 'desc' } })
      .catch(() => null);
    const name = await this.nameFor(pn);
    const lastMessageAt = last?.sentAt ?? null;
    const preview = last ? previewOf(this.msgRowToDto(last)) : null;
    await this.prisma.waChat
      .upsert({
        where: { jid: pn },
        create: {
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

  private chatRowToDto(row: {
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
  }): WaChat {
    return {
      jid: row.jid,
      name: row.name,
      isGroup: row.isGroup,
      unreadCount: row.unreadCount,
      lastMessageTs: row.lastMessageAt ? row.lastMessageAt.getTime() : null,
      lastMessagePreview: row.lastMessagePreview,
      pinned: row.pinned,
      archived: row.archived,
      muted: row.muted,
      // URL backend de la photo de profil (servie à la demande; 404 -> initiales).
      // Le front ajoute le token ?t= pour l'auth.
      avatarUrl: '/api/wa/avatar/' + encodeURIComponent(row.jid),
    };
  }

  private msgRowToDto(row: {
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
  }): WaMessage {
    const dto: WaMessage = {
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
