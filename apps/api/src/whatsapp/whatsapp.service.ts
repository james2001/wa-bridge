import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  type WaChat,
  type WaConnection,
  type WaMessage,
  type WaPresence,
  type WaReaction,
} from '@app/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapWaMessage, previewOf } from './whatsapp.mapper';

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
        browser: ['Whatapp Self-Hosted', 'Chrome', '1.0.0'],
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
      const chat = await this.touchChat(msg, u.type === 'notify' && !msg.fromMe);
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
    // Contacts
    for (const c of h.contacts ?? []) {
      const name = c.name ?? c.notify ?? null;
      await this.prisma.waContact
        .upsert({
          where: { jid: c.id },
          create: {
            jid: c.id,
            name,
            pushName: c.notify ?? null,
            isGroup: isJidGroup(c.id) ?? false,
          },
          update: { name: name ?? undefined, pushName: c.notify ?? undefined },
        })
        .catch(() => undefined);
    }

    // Chats
    for (const ch of h.chats ?? []) {
      if (this.isIgnoredChat(ch.id)) continue;
      const ts = ch.conversationTimestamp;
      const lastAt =
        ts == null
          ? null
          : new Date(
              (typeof ts === 'number' ? ts : ts.toNumber()) * 1000,
            );
      const name = ch.name ?? (await this.nameFor(ch.id));
      await this.prisma.waChat
        .upsert({
          where: { jid: ch.id },
          create: {
            jid: ch.id,
            name,
            isGroup: isJidGroup(ch.id) ?? false,
            unreadCount: ch.unreadCount ?? 0,
            lastMessageAt: lastAt,
          },
          update: {
            name: name ?? undefined,
            unreadCount: ch.unreadCount ?? undefined,
            lastMessageAt: lastAt ?? undefined,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onChatsUpsert(chats: any[]): Promise<void> {
    for (const ch of chats) {
      if (this.isIgnoredChat(ch.id)) continue;
      const name = ch.name ?? (await this.nameFor(ch.id));
      const row = await this.prisma.waChat
        .upsert({
          where: { jid: ch.id },
          create: {
            jid: ch.id,
            name,
            isGroup: isJidGroup(ch.id) ?? false,
            unreadCount: ch.unreadCount ?? 0,
          },
          update: { name: name ?? undefined, unreadCount: ch.unreadCount ?? undefined },
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
      if (!hasUnread && !ch.name) continue; // rien d'intéressant ici
      const jid = (await this.resolvePn(ch.id)) ?? ch.id;
      const unread = hasUnread ? Math.max(0, ch.unreadCount as number) : undefined;
      const name: string | undefined = ch.name ?? undefined;
      const row = await this.prisma.waChat
        .upsert({
          where: { jid },
          create: {
            jid,
            name: name ?? (await this.nameFor(jid)),
            isGroup: isJidGroup(jid) ?? false,
            unreadCount: unread ?? 0,
          },
          update: {
            ...(unread !== undefined ? { unreadCount: unread } : {}),
            ...(name ? { name } : {}),
          },
        })
        .catch(() => null);
      if (row) this.emit('chat-upsert', this.chatRowToDto(row));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async onContactsUpsert(contacts: any[]): Promise<void> {
    for (const c of contacts) {
      const name = c.name ?? c.notify ?? null;
      await this.prisma.waContact
        .upsert({
          where: { jid: c.id },
          create: {
            jid: c.id,
            name,
            pushName: c.notify ?? null,
            isGroup: isJidGroup(c.id) ?? false,
          },
          update: { name: name ?? undefined, pushName: c.notify ?? undefined },
        })
        .catch(() => undefined);
    }
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
    const chat = await this.touchChat(msg, false);
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
    const chat = await this.touchChat(msg, false);
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
      .map((r) => this.chatRowToDto(r));
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

  private async touchChat(
    m: WaMessage,
    incrementUnread: boolean,
  ): Promise<WaChat | null> {
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
    return c?.name ?? c?.pushName ?? null;
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
  private canonicalJid(jid: string | null | undefined): string | null {
    if (!jid) return null;
    if (!isLidUser(jid)) return jid;
    let norm: string;
    try {
      norm = jidNormalizedUser(jid);
    } catch {
      norm = jid;
    }
    return this.lidToPn.get(norm) ?? this.lidToPn.get(jid) ?? jid;
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
    if (!isLidUser(jid)) return jid;
    const cached = this.lidToPn.get(jid);
    if (cached) return cached;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lm = (this.sock as any)?.signalRepository?.lidMapping;
      const pn: string | null | undefined = lm?.getPNForLID
        ? await lm.getPNForLID(jid)
        : null;
      if (pn && pn.endsWith('@s.whatsapp.net')) {
        await this.learnLid(jid, pn);
        return pn;
      }
    } catch {
      /* noop */
    }
    return jid;
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
      avatarUrl: row.avatarUrl,
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
