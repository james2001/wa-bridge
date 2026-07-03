import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappAgentController } from './whatsapp-agent.controller';
import { WhatsappGateway } from './whatsapp.gateway';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [AuthModule], // pour JwtService (auth du handshake socket)
  // WhatsappController: API humaine (JWT). WhatsappAgentController: API
  // Agent/LLM (clé statique X-API-Key), distincte et opt-in.
  controllers: [WhatsappController, WhatsappAgentController],
  providers: [WhatsappService, WhatsappGateway],
  exports: [WhatsappService],
})
export class WhatsappModule {}
