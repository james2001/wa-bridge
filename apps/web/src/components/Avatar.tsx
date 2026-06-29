import { useEffect, useState } from 'react';
import { useAppSelector } from '../app/hooks';
import { selectAccessToken } from '../features/auth/authSlice';
import { initials } from '../lib/format';

interface Props {
  name: string;
  jid: string;
  avatarUrl: string | null;
  size?: 'sm' | 'md' | 'lg';
}

// Avatar avec photo de profil et repli sur les initiales.
// La photo est servie par le backend (auth par token en query ?t=).
// Repli sur les initiales si avatarUrl est null OU si l'image échoue (404, etc.).
export default function Avatar({ name, jid, avatarUrl, size = 'md' }: Props) {
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
  const src =
    avatarUrl && token
      ? `${avatarUrl}?t=${encodeURIComponent(token)}`
      : avatarUrl ?? undefined;

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
