import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
  WaChat,
  WaConnection,
  WaMessage,
  WaMessageStatus,
  WaPresence,
  WaReaction,
} from '@app/shared-types';
import { parseCorsOrigins } from '../config/configuration';
import { WhatsappService } from './whatsapp.service';

type AppServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

@WebSocketGateway({
  cors: {
    origin: parseCorsOrigins(process.env.CORS_ORIGINS),
    credentials: true,
  },
  transports: ['websocket'],
})
export class WhatsappGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(WhatsappGateway.name);
  private forwardingWired = false;

  @WebSocketServer()
  private server!: AppServer;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly wa: WhatsappService,
  ) {}

  afterInit(server: AppServer): void {
    // Auth du handshake par JWT access.
    server.use((socket: AppSocket, next: (err?: Error) => void) => {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('unauthorized'));
      try {
        const payload = this.jwt.verify<{ sub: string }>(token, {
          secret: this.config.get<string>('jwt.accessSecret') as string,
        });
        socket.data.appUserId = payload.sub;
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });

    // Relaie les événements du service WhatsApp vers tous les clients web.
    // Phase 1 (mono-compte): on conserve le broadcast (server.emit) — un seul
    // compte ⇒ broadcast ≡ room unique. Chaque payload porte `accountId`.
    // TODO multi-compte: router vers une room `account:<accountId>`.
    if (!this.forwardingWired) {
      this.forwardingWired = true;
      // conn.accountId déjà présent dans le DTO.
      this.wa.on('connection', (_accountId: string, conn: WaConnection) =>
        this.server.emit('wa:connection', conn),
      );
      this.wa.on('message', (accountId: string, message: WaMessage) =>
        this.server.emit('wa:message', { accountId, message }),
      );
      this.wa.on(
        'message-status',
        (
          accountId: string,
          p: { id: string; chatJid: string; status: WaMessageStatus },
        ) => this.server.emit('wa:message-status', { accountId, ...p }),
      );
      this.wa.on('chats', (accountId: string, chats: WaChat[]) =>
        this.server.emit('wa:chats', { accountId, chats }),
      );
      this.wa.on('chat-upsert', (accountId: string, chat: WaChat) =>
        this.server.emit('wa:chat-upsert', { accountId, chat }),
      );
      this.wa.on(
        'history-synced',
        (accountId: string, p: { chatJid: string | null }) =>
          this.server.emit('wa:history-synced', { accountId, ...p }),
      );
      this.wa.on(
        'reaction',
        (
          accountId: string,
          p: { chatJid: string; messageId: string; reactions: WaReaction[] },
        ) => this.server.emit('wa:reaction', { accountId, ...p }),
      );
      // p.accountId déjà présent dans le DTO WaPresence.
      this.wa.on('presence', (_accountId: string, p: WaPresence) =>
        this.server.emit('wa:presence', p),
      );
    }
  }

  async handleConnection(socket: AppSocket): Promise<void> {
    this.logger.log(`Client socket connecté: ${socket.id}`);
    // État courant + discussions immédiatement à la connexion d'un client.
    // Phase 1: compte 'default' (le front n'expose pas encore le multi-compte).
    socket.emit('wa:connection', this.wa.getConnection('default'));
    try {
      const chats = await this.wa.listChats('default');
      socket.emit('wa:chats', { accountId: 'default', chats });
    } catch (e) {
      this.logger.error(`listChats au connect: ${e}`);
    }
  }

  @SubscribeMessage('wa:send-text')
  async onSendText(
    @MessageBody()
    input: {
      accountId?: string;
      chatJid: string;
      text: string;
      clientId: string;
    },
  ): Promise<{ ok: boolean; message?: WaMessage; error?: string }> {
    const accountId = input.accountId ?? 'default';
    try {
      const message = await this.wa.sendText(
        accountId,
        input.chatJid,
        input.text,
        input.clientId,
      );
      return { ok: true, message };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'send_failed' };
    }
  }

  @SubscribeMessage('wa:mark-read')
  async onMarkRead(
    @MessageBody() input: { accountId?: string; chatJid: string },
  ): Promise<void> {
    await this.wa.markRead(input.accountId ?? 'default', input.chatJid);
  }

  @SubscribeMessage('wa:typing')
  async onTyping(
    @MessageBody() input: { accountId?: string; chatJid: string; typing: boolean },
  ): Promise<void> {
    await this.wa.setTyping(input.accountId ?? 'default', input.chatJid, input.typing);
  }

  @SubscribeMessage('wa:archive')
  async onArchive(
    @MessageBody() input: { accountId?: string; chatJid: string; archived: boolean },
  ): Promise<void> {
    this.logger.log(`wa:archive ${input.chatJid} -> ${input.archived}`);
    await this.wa.setArchived(input.accountId ?? 'default', input.chatJid, input.archived);
  }

  @SubscribeMessage('wa:mute')
  async onMute(
    @MessageBody() input: { accountId?: string; chatJid: string; muted: boolean },
  ): Promise<void> {
    this.logger.log(`wa:mute ${input.chatJid} -> ${input.muted}`);
    await this.wa.setMuted(input.accountId ?? 'default', input.chatJid, input.muted);
  }

  @SubscribeMessage('wa:block')
  async onBlock(
    @MessageBody() input: { accountId?: string; chatJid: string; blocked: boolean },
  ): Promise<void> {
    this.logger.log(`wa:block ${input.chatJid} -> ${input.blocked}`);
    await this.wa.setBlocked(input.accountId ?? 'default', input.chatJid, input.blocked);
  }

  @SubscribeMessage('wa:subscribe-presence')
  async onSubscribePresence(
    @MessageBody() input: { accountId?: string; jid: string },
  ): Promise<void> {
    await this.wa.subscribePresence(input.accountId ?? 'default', input.jid);
  }

  @SubscribeMessage('wa:logout')
  async onLogout(
    @MessageBody() input: { accountId?: string },
    @ConnectedSocket() _socket: AppSocket,
  ): Promise<{ ok: boolean }> {
    await this.wa.logout(input?.accountId ?? 'default');
    return { ok: true };
  }
}
