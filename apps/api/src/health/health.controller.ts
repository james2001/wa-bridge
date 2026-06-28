import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

interface HealthResponse {
  status: 'ok' | 'degraded';
  db: boolean;
  whatsapp: string; // état de la connexion WhatsApp
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappService,
  ) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const db = await this.checkDb();
    return {
      status: db ? 'ok' : 'degraded',
      db,
      whatsapp: this.wa.getConnection().state,
    };
  }

  private async checkDb(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
