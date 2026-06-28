import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthSession } from '@app/shared-types';

interface TokenPayload {
  sub: string; // 'app'
}

@Injectable()
export class AuthService {
  // Identité unique de l'app (mono-utilisateur: c'est ton accès au pont).
  private static readonly APP_SUBJECT = 'app';

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** Vérifie le mot de passe d'app (comparaison à temps constant) et émet les tokens. */
  login(password: string): { session: AuthSession; refreshToken: string } {
    const expected = this.config.get<string>('appPassword') as string;
    const a = createHash('sha256').update(password).digest();
    const b = createHash('sha256').update(expected).digest();
    if (!timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Mot de passe incorrect');
    }
    return this.issueTokens();
  }

  /** Rotation: vérifie le refresh token et émet une nouvelle paire. */
  refresh(refreshToken: string | undefined): {
    accessToken: string;
    refreshToken: string;
  } {
    if (!refreshToken) throw new UnauthorizedException('Refresh token manquant');
    try {
      this.jwt.verify<TokenPayload>(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret') as string,
      });
    } catch {
      throw new UnauthorizedException('Refresh token invalide');
    }
    const { session, refreshToken: next } = this.issueTokens();
    return { accessToken: session.accessToken, refreshToken: next };
  }

  private issueTokens(): { session: AuthSession; refreshToken: string } {
    const payload: TokenPayload = { sub: AuthService.APP_SUBJECT };
    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('jwt.accessSecret') as string,
      expiresIn: this.config.get<string>('jwt.accessTtl') as string,
    });
    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('jwt.refreshSecret') as string,
      expiresIn: this.config.get<string>('jwt.refreshTtl') as string,
    });
    return { session: { accessToken }, refreshToken };
  }
}
