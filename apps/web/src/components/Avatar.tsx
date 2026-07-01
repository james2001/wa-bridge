import { useEffect, useState } from 'react';
import { DEFAULT_ACCOUNT_ID } from '@app/shared-types';
import { useAppSelector } from '../app/hooks';
import { selectAccessToken } from '../features/auth/authSlice';
import { initials } from '../lib/format';
import { authedMediaUrl } from '../lib/mediaUrl';

interface Props {
  name: string;
  jid: string;
  avatarUrl: string | null;
  // Compte propriétaire de la photo (routage backend multi-compte).
  accountId?: string;
  size?: 'sm' | 'md' | 'lg';
}

// Avatar avec photo de profil et repli sur les initiales.
// La photo est servie par le backend (auth par token en query ?t=, + accountId).
// Repli sur les initiales si avatarUrl est null OU si l'image échoue (404, etc.).
export default function Avatar({
  name,
  jid,
  avatarUrl,
  accountId = DEFAULT_ACCOUNT_ID,
  size = 'md',
}: Props) {
  const token = useAppSelector(selectAccessToken);
  const [failed, setFailed] = useState(false);

  // Réinitialise l'état d'échec si la source change (nouvelle photo / autre chat).
  useEffect(() => {
    setFailed(false);
  }, [avatarUrl, jid]);

  const className =
    'avatar' +
    (size === 'sm' ? ' avatar--sm' : size === 'lg' ? ' avatar--lg' : '');
  const showImage = Boolean(avatarUrl) && !failed;
  const src = authedMediaUrl(avatarUrl, token, accountId) ?? undefined;

  return (
    <div className={className}>
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        initials(name)
      )}
    </div>
  );
}
