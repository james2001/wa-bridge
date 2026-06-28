import { useCallback, useEffect, useState } from 'react';
import type { WaMediaInfo, WaMessage } from '@app/shared-types';
import { useAppSelector } from '../../app/hooks';
import { selectAccessToken } from '../auth/authSlice';

interface Props {
  // L'appelant garantit message.media non nul.
  message: WaMessage;
}

// Emoji représentatif par type de média (utilisé pour les placeholders).
const KIND_EMOJI: Record<WaMediaInfo['kind'], string> = {
  image: '📷',
  video: '🎬',
  audio: '🎵',
  document: '📎',
  sticker: '🏷️',
};

// data URI à partir d'une miniature base64 (preview pendant le chargement).
function thumbDataUri(thumb: string | null): string | undefined {
  return thumb ? `data:image/jpeg;base64,${thumb}` : undefined;
}

// Formate une durée en secondes en m:ss (ex. 75 -> "1:15").
function formatDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Formate une taille d'octets en o / Ko / Mo (lisible).
function formatSize(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

// Overlay plein écran (image ou vidéo en grand). Ferme au clic ou via Échap.
function Lightbox({
  kind,
  src,
  poster,
  onClose,
}: {
  kind: 'image' | 'video';
  src: string;
  poster: string | undefined;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <button
        type="button"
        className="lightbox__close"
        onClick={onClose}
        aria-label="Fermer"
      >
        ✕
      </button>
      {kind === 'image' ? (
        <img
          className="lightbox__content"
          src={src}
          alt=""
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <video
          className="lightbox__content"
          src={src}
          poster={poster}
          controls
          autoPlay
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}

// Placeholder discret affiché quand le média est indisponible ou en erreur.
function Unavailable({ kind }: { kind: WaMediaInfo['kind'] }) {
  return (
    <div className="media-unavailable">
      <span className="media-unavailable__emoji">{KIND_EMOJI[kind]}</span>
      <span>Média indisponible</span>
    </div>
  );
}

export default function MediaContent({ message }: Props) {
  const media = message.media;
  const token = useAppSelector(selectAccessToken);
  const [failed, setFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const onError = useCallback(() => setFailed(true), []);
  const closeLightbox = useCallback(() => setLightboxOpen(false), []);

  // Sécurité: l'appelant garantit media non nul, mais on reste défensif.
  if (!media) return null;

  const src =
    media.url && token
      ? media.url + '?t=' + encodeURIComponent(token)
      : null;
  const poster = thumbDataUri(media.thumbnailBase64);

  // Légende: priorité à la légende du média, repli sur le texte du message.
  const caption = media.caption ?? message.text;

  // Média non disponible (pas d'URL/token) ou erreur de chargement.
  const showUnavailable = src === null || failed;

  let content: JSX.Element;

  if (showUnavailable) {
    content = <Unavailable kind={media.kind} />;
  } else {
    switch (media.kind) {
      case 'image':
        content = (
          <img
            className="media-image"
            src={src}
            // Affiche la miniature comme arrière-plan pendant le chargement.
            style={
              poster
                ? { backgroundImage: `url(${poster})` }
                : undefined
            }
            loading="lazy"
            alt={caption ?? 'Image'}
            onError={onError}
            onClick={() => setLightboxOpen(true)}
          />
        );
        break;
      case 'video':
        content = (
          <video
            className="media-video"
            src={src}
            poster={poster}
            controls
            preload="metadata"
            onError={onError}
            onDoubleClick={() => setLightboxOpen(true)}
          />
        );
        break;
      case 'audio': {
        const duration = formatDuration(media.durationSec);
        content = (
          <div className="media-audio">
            <div className="media-audio__head">
              <span className="media-audio__label">
                {media.ptt ? '🎙️ Message vocal' : '🎵 Audio'}
              </span>
              {duration && (
                <span className="media-audio__duration">{duration}</span>
              )}
            </div>
            <audio
              className="media-audio__player"
              src={src}
              controls
              preload="none"
              onError={onError}
            />
          </div>
        );
        break;
      }
      case 'document': {
        const size = formatSize(media.sizeBytes);
        const name = media.fileName ?? 'Document';
        content = (
          <a
            className="media-doc"
            href={src}
            download={media.fileName ?? undefined}
            target="_blank"
            rel="noreferrer"
          >
            <span className="media-doc__icon">📎</span>
            <span className="media-doc__info">
              <span className="media-doc__name">{name}</span>
              <span className="media-doc__meta">
                {size ? `${size} · ` : ''}Télécharger
              </span>
            </span>
          </a>
        );
        break;
      }
      case 'sticker':
        content = (
          <img
            className="media-sticker"
            src={src}
            loading="lazy"
            alt="Sticker"
            onError={onError}
          />
        );
        break;
      default:
        content = <Unavailable kind={media.kind} />;
        break;
    }
  }

  // La légende est affichée pour les types visuels/fichiers; pour l'audio,
  // elle reste utile si une légende accompagne la note.
  const showCaption = Boolean(caption);

  return (
    <div className="bubble__media">
      {content}
      {showCaption && <span className="media-caption">{caption}</span>}
      {lightboxOpen && src && (media.kind === 'image' || media.kind === 'video') && (
        <Lightbox
          kind={media.kind}
          src={src}
          poster={poster}
          onClose={closeLightbox}
        />
      )}
    </div>
  );
}
