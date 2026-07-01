import { DEFAULT_ACCOUNT_ID } from '@app/shared-types';

// Compose l'URL d'un média/avatar servi par le backend en y ajoutant, dans
// l'ordre, le compte propriétaire (si ce n'est pas le compte par défaut) puis
// le token d'auth (query `?t=`). Renvoie null si l'URL ou le token manque.
//
// Le backend accepte `accountId` en query optionnelle (défaut 'default'), ce qui
// garde les URLs du compte principal inchangées et rétro-compatibles.
export function authedMediaUrl(
  url: string | null | undefined,
  token: string | null | undefined,
  accountId: string = DEFAULT_ACCOUNT_ID,
): string | null {
  if (!url || !token) return null;
  const params = new URLSearchParams();
  if (accountId && accountId !== DEFAULT_ACCOUNT_ID) {
    params.set('accountId', accountId);
  }
  params.set('t', token);
  return `${url}?${params.toString()}`;
}
