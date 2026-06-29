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
  WaChatMediaResponse,
  WaChatsResponse,
  WaConnection,
  WaMessage,
  WaMessagesPage,
} from '@app/shared-types';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { WhatsappService } from './whatsapp.service';

@Controller('wa')
@UseGuards(JwtAuthGuard)
export class WhatsappController {
  constructor(private readonly wa: WhatsappService) {}

  @Get('status')
  status(): WaConnection {
    return this.wa.getConnection();
  }

  @Get('chats')
  async chats(): Promise<WaChatsResponse> {
    return { chats: await this.wa.listChats() };
  }

  // jid encodé côté client (encodeURIComponent) ; Express le décode en param.
  @Get('chats/:jid/messages')
  async messages(
    @Param('jid') jid: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<WaMessagesPage> {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const bef = before ? Number(before) : null;
    return this.wa.listMessages(jid, bef, lim);
  }

  // Galerie média d'une discussion (« Médias, liens et documents »), tous les
  // médias récents d'abord. Coexiste avec le POST de même chemin (envoi média).
  // jid encodé côté client (encodeURIComponent) ; Express le décode en param.
  @Get('chats/:jid/media')
  async chatMedia(@Param('jid') jid: string): Promise<WaChatMediaResponse> {
    return { items: await this.wa.listChatMedia(jid) };
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
  ): Promise<WaMessage> {
    if (!file) throw new BadRequestException('Fichier manquant');
    return this.wa.sendMedia(jid, file, caption);
  }

  // Média déchiffré à la demande (cache disque). Auth via header Bearer OU ?t=.
  // chatJid encodé côté client (encodeURIComponent) ; Express le décode en param.
  @Get('media/:chatJid/:id')
  async media(
    @Param('chatJid') chatJid: string,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, mimetype, fileName } = await this.wa.getMedia(chatJid, id);
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
  ): Promise<void> {
    const { buffer, mimetype } = await this.wa.getAvatar(jid);
    res.setHeader('Content-Type', mimetype);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  }
}
