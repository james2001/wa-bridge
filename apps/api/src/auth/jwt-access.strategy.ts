import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthUser } from '../common/decorators/current-user.decorator';

export interface AccessTokenPayload {
  sub: string; // 'app'
}

@Injectable()
export class JwtAccessStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      // Token via header Bearer OU paramètre d'URL `t` (pour <img>/<video> média).
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('t'),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret') as string,
    });
  }

  validate(payload: AccessTokenPayload): AuthUser {
    if (!payload?.sub) {
      throw new UnauthorizedException();
    }
    return { appUserId: payload.sub };
  }
}
