import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type {
  WaAccountsResponse,
  WaChatMediaResponse,
  WaChatsResponse,
  WaConnection,
  WaContactAbout,
  WaMessage,
  WaMessageInfoResponse,
  WaMessagesPage,
  WaPeopleResponse,
} from '@app/shared-types';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { WhatsappService } from './whatsapp.service';

@Controller('wa')
@UseGuards(JwtAuthGuard)
export class WhatsappController {
  constructor(private readonly wa: WhatsappService) {}

  // Liste des comptes liés au pont (multi-compte). Phase 1: un seul ('default').
  @Get('accounts')
  async accounts(): Promise<WaAccountsResponse> {
    return this.wa.listAccounts();
  }

  // accountId en query optionnelle (défaut 'default') -> URLs existantes
  // inchangées, rétro-compatibles avec le front actuel.
  @Get('status')
  status(@Query('accountId') accountId = 'default'): WaConnection {
    return this.wa.getConnection(accountId);
  }

  @Get('chats')
  async chats(
    @Query('accountId') accountId = 'default',
  ): Promise<WaChatsResponse> {
    return { chats: await this.wa.listChats(accountId) };
  }

  // jid encodé côté client (encodeURIComponent) ; Express le décode en param.
  @Get('chats/:jid/messages')
  async messages(
    @Param('jid') jid: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
    @Query('accountId') accountId = 'default',
  ): Promise<WaMessagesPage> {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const bef = before ? Number(before) : null;
    return this.wa.listMessages(accountId, jid, bef, lim);
  }

  // Détail des accusés par destinataire (panneau « Infos du message »).
  // jid encodé côté client (encodeURIComponent) ; Express le décode en param.
  @Get('chats/:jid/messages/:id/info')
  async messageInfo(
    @Param('jid') jid: string,
    @Param('id') id: string,
    @Query('accountId') accountId = 'default',
  ): Promise<WaMessageInfoResponse> {
    return this.wa.getMessageInfo(accountId, jid, id);
  }

  // Galerie média d'une discussion (« Médias, liens et documents »), tous les
  // médias récents d'abord. Coexiste avec le POST de même chemin (envoi média).
  // jid encodé côté client (encodeURIComponent) ; Express le décode en param.
  @Get('chats/:jid/media')
  async chatMedia(
    @Param('jid') jid: string,
    @Query('accountId') accountId = 'default',
  ): Promise<WaChatMediaResponse> {
    return { items: await this.wa.listChatMedia(accountId, jid) };
  }

  // Envoi d'un média (image/vidéo/audio/document) depuis le pont vers WhatsApp.
  // jid encodé côté client (encodeURIComponent) ; Express le décode en param.
  @Post('chats/:jid/media')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 80 * 1024 * 1024 } }),
  )
  async sendMedia(
    @Param('jid') jid: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('caption') caption?: string,
    @Query('accountId') accountId = 'default',
  ): Promise<WaMessage> {
    if (!file) throw new BadRequestException('Fichier manquant');
    return this.wa.sendMedia(accountId, jid, file, caption);
  }

  // Média déchiffré à la demande (cache disque). Auth via header Bearer OU ?t=.
  // chatJid encodé côté client (encodeURIComponent) ; Express le décode en param.
  @Get('media/:chatJid/:id')
  async media(
    @Param('chatJid') chatJid: string,
    @Param('id') id: string,
    @Res() res: Response,
    @Query('accountId') accountId = 'default',
  ): Promise<void> {
    const { buffer, mimetype, fileName } = await this.wa.getMedia(
      accountId,
      chatJid,
      id,
    );
    res.setHeader('Content-Type', mimetype);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // Documents -> téléchargement avec nom ; autres médias -> affichage inline.
    res.setHeader(
      'Content-Disposition',
      fileName
        ? `attachment; filename="${encodeURIComponent(fileName)}"`
        : 'inline',
    );
    res.send(buffer);
  }

  // Photo de profil d'un contact/groupe. Auth via header Bearer OU ?t=.
  // 404 si pas de photo -> le front affiche les initiales.
  // jid encodé côté client (encodeURIComponent) ; Express le décode en param.
  @Get('avatar/:jid')
  async avatar(
    @Param('jid') jid: string,
    @Res() res: Response,
    @Query('accountId') accountId = 'default',
  ): Promise<void> {
    const { buffer, mimetype } = await this.wa.getAvatar(accountId, jid);
    res.setHeader('Content-Type', mimetype);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  }

  // Personnes (contacts 1:1) agrégées à travers les comptes (vue fusionnée).
  // Transverse: pas de paramètre accountId (chaque personne porte ses accountIds).
  @Get('people')
  async people(): Promise<WaPeopleResponse> {
    return this.wa.listPeople();
  }

  // Timeline fusionnée d'une personne: messages de tous ses comptes, triés par
  // date. jid encodé côté client (encodeURIComponent) ; Express le décode.
  @Get('people/:jid/timeline')
  async personTimeline(
    @Param('jid') jid: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<WaMessagesPage> {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const bef = before ? Number(before) : null;
    return this.wa.listPersonTimeline(jid, bef, lim);
  }

  // Bio « À propos » (statut) d'un contact. Best-effort (null si masqué/indispo).
  // jid encodé côté client (encodeURIComponent) ; Express le décode en param.
  @Get('contacts/:jid/about')
  async contactAbout(
    @Param('jid') jid: string,
    @Query('accountId') accountId = 'default',
  ): Promise<WaContactAbout> {
    return this.wa.getContactAbout(accountId, jid);
  }
}
