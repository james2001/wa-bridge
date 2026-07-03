import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

/**
 * Journalise chaque appel de l'API Agent/LLM.
 *
 * On ne journalise QUE des métadonnées (route, compte, discussion, longueur du
 * texte, clientId, statut/durée, IP source) — JAMAIS le contenu des messages,
 * pour éviter toute fuite de PII dans les logs.
 */
@Injectable()
export class AgentAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AgentAudit');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const start = Date.now();

    const method = req.method;
    const route = (req.originalUrl ?? req.url).split('?')[0];
    const query = req.query as Record<string, unknown>;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const params = req.params as Record<string, unknown>;

    const accountId =
      (typeof query.accountId === 'string' ? query.accountId : undefined) ??
      (typeof body.accountId === 'string' ? body.accountId : undefined) ??
      'default';
    const jid = typeof params.jid === 'string' ? params.jid : null;
    const textLength =
      typeof body.text === 'string' ? body.text.length : null;
    const clientId = typeof body.clientId === 'string' ? body.clientId : null;
    const ip = req.ip ?? req.socket?.remoteAddress ?? null;

    const base =
      `agent ${method} ${route} account=${accountId} jid=${jid ?? '-'} ` +
      `textLen=${textLength ?? '-'} clientId=${clientId ?? '-'} ip=${ip ?? '-'}`;

    return next.handle().pipe(
      tap(() => {
        this.logger.log(`${base} status=ok durationMs=${Date.now() - start}`);
      }),
      catchError((err: unknown) => {
        const message = err instanceof Error ? err.message : 'error';
        this.logger.warn(
          `${base} status=error error=${message} durationMs=${Date.now() - start}`,
        );
        return throwError(() => err);
      }),
    );
  }
}
