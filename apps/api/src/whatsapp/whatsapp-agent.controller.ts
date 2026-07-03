import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { randomUUID } from 'node:crypto';
import type {
  WaAccountsResponse,
  WaAgentSearchResponse,
  WaAgentSendResponse,
  WaChat,
  WaChatsResponse,
  WaMessage,
  WaMessagesPage,
} from '@app/shared-types';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { AgentAuditInterceptor } from '../common/interceptors/agent-audit.interceptor';
import { WhatsappService } from './whatsapp.service';

// Corps validé de l'envoi de texte agent (ValidationPipe global: whitelist +
// transform). Implémente WaAgentSendTextRequest.
class AgentSendTextDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text!: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/**
 * API Agent/LLM (server-to-server) — lecture ET écriture des messages WhatsApp.
 *
 * Séparée de l'API humaine (JWT). Authentification par clé statique
 * (`X-API-Key`, ApiKeyGuard fail-closed), throttling par route et audit
 * systématique (métadonnées seulement). L'écriture est protégée par des
 * garde-fous supplémentaires (flag global + allow-lists + dry-run).
 *
 * Préfixe réel: `/api/agent/wa` (préfixe global 'api' de main.ts).
 */
@Controller('agent/wa')
@UseGuards(ApiKeyGuard, ThrottlerGuard)
@UseInterceptors(AgentAuditInterceptor)
export class WhatsappAgentController {
  constructor(
    private readonly wa: WhatsappService,
    private readonly config: ConfigService,
  ) {}

  // --- Lecture (throttle plus permissif: 60/min) ---

  @Get('accounts')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async accounts(): Promise<WaAccountsResponse> {
    return this.wa.listAccounts();
  }

  @Get('chats')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async chats(
    @Query('accountId') accountId = 'default',
  ): Promise<WaChatsResponse> {
    return { chats: await this.wa.listChats(accountId) };
  }

  @Get('chats/:jid/messages')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async messages(
    @Param('jid') jid: string,
    @Query('accountId') accountId = 'default',
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<WaMessagesPage> {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const bef = Number(before) || null;
    return this.wa.listMessages(accountId, jid, bef, lim);
  }

  // Recherche: discussions (défaut, filtrées en mémoire sur nom/JID) OU
  // plein-texte des messages (scope=messages).
  @Get('search')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async search(
    @Query('q') q = '',
    @Query('accountId') accountId = 'default',
    @Query('scope') scope: 'chats' | 'messages' = 'chats',
    @Query('limit') limit?: string,
  ): Promise<WaAgentSearchResponse> {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const needle = q.trim().toLowerCase();
    if (scope === 'messages') {
      const messages = await this.wa.searchMessages(accountId, q, lim);
      return { chats: [], messages };
    }
    const all = await this.wa.listChats(accountId);
    const chats: WaChat[] = needle
      ? all
          .filter(
            (c) =>
              (c.name ?? '').toLowerCase().includes(needle) ||
              c.jid.toLowerCase().includes(needle),
          )
          .slice(0, lim)
      : all.slice(0, lim);
    return { chats, messages: [] };
  }

  // --- Écriture (throttle strict: 10/min + garde-fous) ---

  @Post('chats/:jid/text')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async sendText(
    @Param('jid') jid: string,
    @Body() body: AgentSendTextDto,
  ): Promise<WaAgentSendResponse> {
    // Garde-fou 1: l'écriture doit être explicitement activée.
    if (this.config.get<boolean>('agentWriteEnabled') !== true) {
      throw new ForbiddenException("Écriture agent désactivée");
    }

    const accountId = body.accountId ?? 'default';
    const clientId = body.clientId ?? randomUUID();

    // Garde-fou 2: allow-lists (compte + discussion).
    this.assertAllowed(accountId, jid);

    // Dry-run: valide + prévisualise (jamais le contenu) sans rien envoyer.
    if (body.dryRun === true) {
      return {
        dryRun: true,
        clientId,
        message: null,
        preview: { accountId, chatJid: jid, textLength: body.text.length },
      };
    }

    try {
      const message = await this.wa.sendText(accountId, jid, body.text, clientId);
      return { dryRun: false, clientId, message };
    } catch (e) {
      throw this.mapSendError(e);
    }
  }

  // Envoi d'un média (image/vidéo/audio/document). Doublement opt-in: nécessite
  // l'écriture ET le flag média (défaut false => 403). Calqué sur l'endpoint
  // humain (FileInterceptor 80 Mo -> wa.sendMedia), avec les mêmes garde-fous.
  @Post('chats/:jid/media')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 80 * 1024 * 1024 } }),
  )
  async sendMedia(
    @Param('jid') jid: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('caption') caption?: string,
    @Query('accountId') accountId = 'default',
  ): Promise<WaMessage> {
    if (this.config.get<boolean>('agentWriteEnabled') !== true) {
      throw new ForbiddenException('Écriture agent désactivée');
    }
    if (this.config.get<boolean>('agentAllowMedia') !== true) {
      throw new ForbiddenException('Envoi média agent désactivé');
    }
    this.assertAllowed(accountId, jid);
    if (!file) throw new BadRequestException('Fichier manquant');
    try {
      return await this.wa.sendMedia(accountId, jid, file, caption);
    } catch (e) {
      throw this.mapSendError(e);
    }
  }

  // Applique les allow-lists (vides => aucune restriction). Lève 403 si la
  // cible n'est pas autorisée.
  private assertAllowed(accountId: string, jid: string): void {
    const accountAllow =
      this.config.get<string[]>('agentAccountAllowlist') ?? [];
    if (accountAllow.length > 0 && !accountAllow.includes(accountId)) {
      throw new ForbiddenException("Compte non autorisé pour l'agent");
    }
    const chatAllow = this.config.get<string[]>('agentChatAllowlist') ?? [];
    if (chatAllow.length > 0 && !chatAllow.includes(jid)) {
      throw new ForbiddenException("Discussion non autorisée pour l'agent");
    }
  }

  // Mappe l'erreur "WhatsApp non connecté" en 503 (réessayable), sinon propage.
  private mapSendError(e: unknown): Error {
    if (e instanceof Error && e.message === 'WhatsApp non connecté') {
      return new ServiceUnavailableException('WhatsApp non connecté');
    }
    return e instanceof Error ? e : new Error('send_failed');
  }
}
