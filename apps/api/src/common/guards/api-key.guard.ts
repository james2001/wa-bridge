import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

// Requête enrichie par le guard: marque l'appelant comme un agent authentifié.
// Le scope prépare une éventuelle granularité future (lecture/écriture...).
export interface AgentRequest extends Request {
  agent?: { scope: 'agent' };
}

/**
 * Guard d'authentification de l'API Agent/LLM (server-to-server).
 *
 * - Lit le header `X-API-Key` et le compare à `agentApiKey` à TEMPS CONSTANT
 *   (SHA-256 -> longueur fixe, puis timingSafeEqual), même pattern que
 *   AuthService.login pour ne pas fuiter d'information par timing.
 * - FAIL-CLOSED: si aucune clé n'est configurée (feature opt-in), l'API est
 *   entièrement refusée. Aucune requête ne passe tant que l'exploitant n'a pas
 *   posé `AGENT_API_KEY`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string | null>('agentApiKey');
    // Fail-closed: pas de clé configurée => API agent fermée.
    if (!expected || expected.length === 0) {
      throw new UnauthorizedException('API agent désactivée');
    }

    const req = context.switchToHttp().getRequest<AgentRequest>();
    const raw = req.headers['x-api-key'];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (typeof provided !== 'string' || provided.length === 0) {
      throw new UnauthorizedException('Clé API manquante');
    }

    // Comparaison à temps constant (cf. auth.service.ts): le hachage préalable
    // aligne les longueurs pour timingSafeEqual et masque la longueur de la clé.
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(expected).digest();
    if (!timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Clé API invalide');
    }

    req.agent = { scope: 'agent' };
    return true;
  }
}
