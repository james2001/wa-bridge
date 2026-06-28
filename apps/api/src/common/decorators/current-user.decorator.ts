import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Identité authentifiée attachée à la requête par la stratégie JWT. */
export interface AuthUser {
  appUserId: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    return request.user;
  },
);
