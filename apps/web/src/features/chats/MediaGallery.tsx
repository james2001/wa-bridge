import { useCallback, useEffect, useState } from 'react';
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
      {target.kind === 'image' ? (
        <img
          className="lightbox__content"
          src={target.src}
          alt=""
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
  const isVisual =
    item.kind === 'image' || item.kind === 'video' || item.kind === 'sticker';

  // Aperçu: miniature instantanée si dispo, sinon l'URL servie (visuels).
  const previewSrc = thumb ?? (isVisual ? (src ?? undefined) : undefined);

  if (isVisual && previewSrc && !failed) {
    // Source plein écran: l'URL complète pour la vidéo ; pour l'image, l'URL
    // si dispo, sinon la miniature agrandie.
    const lbKind: 'image' | 'video' = item.kind === 'video' ? 'video' : 'image';
    const lbSrc = item.kind === 'video' ? src : (src ?? thumb ?? null);

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
        {item.kind === 'video' && <span className="gallery__play">▶</span>}
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
