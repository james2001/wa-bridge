import { useCallback, useEffect, useRef, useState } from 'react';
import type { WaMediaItem } from '@app/shared-types';
import { useAppSelector } from '../../app/hooks';
import { selectAccessToken } from '../auth/authSlice';
import { useGetChatMediaQuery } from './chatsApi';

interface Props {
  jid: string;
}

// Emoji représentatif par type de média (tuiles audio/document).
const KIND_EMOJI: Record<WaMediaItem['kind'], string> = {
  image: '📷',
  video: '🎬',
  audio: '🎵',
  document: '📎',
  sticker: '🏷️',
};

// Libellé de secours quand le média n'a ni nom de fichier ni légende.
const KIND_LABEL: Record<WaMediaItem['kind'], string> = {
  image: 'Image',
  video: 'Vidéo',
  audio: 'Audio',
  document: 'Document',
  sticker: 'Sticker',
};

// data URI à partir d'une miniature base64 (aperçu instantané).
function thumbDataUri(thumb: string | null): string | undefined {
  return thumb ? `data:image/jpeg;base64,${thumb}` : undefined;
}

// URL média servie par le backend (auth par token en query ?t=).
function mediaSrc(url: string | null, token: string | null): string | null {
  return url && token ? url + '?t=' + encodeURIComponent(token) : null;
}

// Cible de la lightbox: image affichée en grand ou vidéo lue en grand.
interface LightboxTarget {
  kind: 'image' | 'video';
  src: string;
}

// Overlay plein écran (image ou vidéo). Ferme au clic ou via Échap.
function Lightbox({
  target,
  onClose,
}: {
  target: LightboxTarget;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Déplace le focus dans la modale puis le restaure à la fermeture (a11y).
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="lightbox"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Aperçu du média"
    >
      <button
        type="button"
        ref={closeRef}
        className="lightbox__close"
        onClick={onClose}
        aria-label="Fermer"
      >
        ✕
      </button>
      {target.kind === 'image' ? (
        <img
          className="lightbox__content"
          src={target.src}
          alt="Aperçu du média"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <video
          className="lightbox__content"
          src={target.src}
          controls
          autoPlay
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}

// Une vignette de la grille. Images/vidéos/stickers -> aperçu carré cliquable
// (ouvre la lightbox) ; audio/document -> tuile icône + nom (lien de
// téléchargement quand l'URL est disponible).
function GalleryTile({
  item,
  token,
  onOpen,
}: {
  item: WaMediaItem;
  token: string | null;
  onOpen: (target: LightboxTarget) => void;
}) {
  const [failed, setFailed] = useState(false);

  const thumb = thumbDataUri(item.thumbnailBase64);
  const src = mediaSrc(item.url, token);
  const isImageLike = item.kind === 'image' || item.kind === 'sticker';
  const isVideo = item.kind === 'video';

  // Aperçu image: miniature si dispo, sinon l'URL — UNIQUEMENT pour image/sticker.
  // On ne met JAMAIS l'URL d'une vidéo dans un <img> (téléchargerait tout le fichier).
  const previewSrc = thumb ?? (isImageLike ? (src ?? undefined) : undefined);

  if ((isImageLike || isVideo) && previewSrc && !failed) {
    const lbKind: 'image' | 'video' = isVideo ? 'video' : 'image';
    const lbSrc = isVideo ? src : (src ?? thumb ?? null);
    return (
      <button
        type="button"
        className="gallery__tile"
        disabled={!lbSrc}
        onClick={lbSrc ? () => onOpen({ kind: lbKind, src: lbSrc }) : undefined}
        title={item.caption ?? item.fileName ?? KIND_LABEL[item.kind]}
      >
        <img
          className="gallery__img"
          src={previewSrc}
          alt={item.caption ?? KIND_LABEL[item.kind]}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
        {isVideo && <span className="gallery__play">▶</span>}
      </button>
    );
  }

  // Vidéo SANS miniature: tuile « play » cliquable -> lightbox vidéo, sans
  // télécharger la vidéo entière dans un <img>.
  if (isVideo && src) {
    return (
      <button
        type="button"
        className="gallery__tile gallery__tile--video"
        onClick={() => onOpen({ kind: 'video', src })}
        title={item.caption ?? item.fileName ?? KIND_LABEL.video}
      >
        <span className="gallery__play gallery__play--big">▶</span>
      </button>
    );
  }

  // audio / document, ou visuel sans aperçu / en erreur.
  const icon = KIND_EMOJI[item.kind];
  const name = item.fileName ?? item.caption ?? KIND_LABEL[item.kind];

  if (src) {
    return (
      <a
        className="gallery__file"
        href={src}
        target="_blank"
        rel="noreferrer"
        download={item.fileName ?? undefined}
        title={name}
      >
        <span className="gallery__file-icon">{icon}</span>
        <span className="gallery__file-name">{name}</span>
      </a>
    );
  }

  return (
    <div className="gallery__file" title={name}>
      <span className="gallery__file-icon">{icon}</span>
      <span className="gallery__file-name">{name}</span>
    </div>
  );
}

// Grille de vignettes des médias d'une discussion + lightbox plein écran.
export default function MediaGallery({ jid }: Props) {
  const token = useAppSelector(selectAccessToken);
  const { data: items, isLoading, isError } = useGetChatMediaQuery(jid);
  const [target, setTarget] = useState<LightboxTarget | null>(null);

  const closeLightbox = useCallback(() => setTarget(null), []);
  const openLightbox = useCallback((t: LightboxTarget) => setTarget(t), []);

  if (isLoading) {
    return <p className="gallery__state">Chargement des médias…</p>;
  }
  if (isError) {
    return <p className="gallery__state">Impossible de charger les médias.</p>;
  }
  if (!items || items.length === 0) {
    return <p className="gallery__state">Aucun média partagé.</p>;
  }

  return (
    <>
      <div className="gallery">
        {items.map((item) => (
          <GalleryTile
            key={item.id}
            item={item}
            token={token}
            onOpen={openLightbox}
          />
        ))}
      </div>
      {target && <Lightbox target={target} onClose={closeLightbox} />}
    </>
  );
}
