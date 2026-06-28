import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  WaChatsResponse,
  WaConnection,
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
}
