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
  WaMessage,
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
    if (!this.forwardingWired) {
      this.forwardingWired = true;
      this.wa.on('connection', (conn) => this.server.emit('wa:connection', conn));
      this.wa.on('message', (message: WaMessage) =>
        this.server.emit('wa:message', { message }),
      );
      this.wa.on('message-status', (p) =>
        this.server.emit('wa:message-status', p),
      );
      this.wa.on('chats', (chats) => this.server.emit('wa:chats', { chats }));
      this.wa.on('chat-upsert', (chat) =>
        this.server.emit('wa:chat-upsert', { chat }),
      );
      this.wa.on('history-synced', (p) =>
        this.server.emit('wa:history-synced', p),
      );
      this.wa.on('reaction', (p) => this.server.emit('wa:reaction', p));
      this.wa.on('presence', (p) => this.server.emit('wa:presence', p));
    }
  }

  async handleConnection(socket: AppSocket): Promise<void> {
    // État courant + discussions immédiatement à la connexion d'un client.
    socket.emit('wa:connection', this.wa.getConnection());
    try {
      const chats = await this.wa.listChats();
      socket.emit('wa:chats', { chats });
    } catch (e) {
      this.logger.error(`listChats au connect: ${e}`);
    }
  }

  @SubscribeMessage('wa:send-text')
  async onSendText(
    @MessageBody()
    input: { chatJid: string; text: string; clientId: string },
  ): Promise<{ ok: boolean; message?: WaMessage; error?: string }> {
    try {
      const message = await this.wa.sendText(
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
    @MessageBody() input: { chatJid: string },
  ): Promise<void> {
    await this.wa.markRead(input.chatJid);
  }

  @SubscribeMessage('wa:typing')
  async onTyping(
    @MessageBody() input: { chatJid: string; typing: boolean },
  ): Promise<void> {
    await this.wa.setTyping(input.chatJid, input.typing);
  }

  @SubscribeMessage('wa:subscribe-presence')
  async onSubscribePresence(
    @MessageBody() input: { jid: string },
  ): Promise<void> {
    await this.wa.subscribePresence(input.jid);
  }

  @SubscribeMessage('wa:logout')
  async onLogout(
    @ConnectedSocket() _socket: AppSocket,
  ): Promise<{ ok: boolean }> {
    await this.wa.logout();
    return { ok: true };
  }
}
