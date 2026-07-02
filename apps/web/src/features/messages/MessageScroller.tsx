import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { WaMessage } from '@app/shared-types';

// Seuil (px) sous lequel on considère l'utilisateur « collé » au bas: en
// dessous, un nouveau message déclenche l'auto-scroll.
const NEAR_BOTTOM_PX = 150;
// Seuil (px) du haut déclenchant le chargement de l'historique plus ancien.
const NEAR_TOP_PX = 80;

interface Props {
  // Remonte l'état de défilement à chaque changement de conversation/personne.
  resetKey: string;
  // Messages déjà triés par ordre chronologique croissant.
  messages: WaMessage[];
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  // true tant qu'une page d'historique plus ancienne charge (affiche l'indicateur).
  loadingOlder: boolean;
  hasMore: boolean;
  nextBefore: number | null;
  // Demande de charger la page plus ancienne (le parent avance son curseur).
  onLoadOlder: () => void;
  // Rendu d'une bulle (le parent injecte la clé + les props, ex. label compte).
  renderBubble: (message: WaMessage) => ReactNode;
  errorLabel?: string;
  emptyLabel?: string;
}

// Zone de messages défilante réutilisable (préservation de position au préfixe
// d'historique, auto-scroll en bas, bouton « nouveaux messages »). Sans logique
// de données: le parent fournit les messages et le curseur de pagination.
// Utilisée par MessageList (par compte) et PersonTimeline (fusionnée).
export default function MessageScroller({
  resetKey,
  messages,
  isLoading,
  isError,
  isFetching,
  loadingOlder,
  hasMore,
  nextBefore,
  onLoadOlder,
  renderBubble,
  errorLabel = 'Impossible de charger les messages.',
  emptyLabel = 'Aucun message dans cette discussion.',
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Wrapper interne contenant les bulles: sa hauteur est observée (ResizeObserver)
  // pour re-scroller en bas quand un média charge après le scroll initial.
  const contentRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);

  // Position de scroll mémorisée avant un préfixe d'historique (préservation).
  const prependRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(
    null,
  );
  // Scroll initial (ouverture de la discussion) effectué ?
  const didInitialScrollRef = useRef(false);
  // L'utilisateur est-il proche du bas ? (mesuré au scroll, AVANT mutation DOM)
  const atBottomRef = useRef(true);
  // Garde anti-déclenchement multiple d'un chargement d'historique.
  const loadingOlderRef = useRef(false);
  // Comptage précédent pour détecter un ajout en bas (nouveau message).
  const prevCountRef = useRef(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Réinitialise l'état dérivé quand on change de conversation/personne.
  useEffect(() => {
    didInitialScrollRef.current = false;
    atBottomRef.current = true;
    loadingOlderRef.current = false;
    prevCountRef.current = 0;
    setShowJump(false);
  }, [resetKey]);

  // Libère la garde dès que le fetch (succès ou erreur) se termine.
  useEffect(() => {
    if (!isFetching) loadingOlderRef.current = false;
  }, [isFetching]);

  // Gestion du scroll: suivi de la proximité du bas + chargement historique.
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    atBottomRef.current = nearBottom;
    if (nearBottom) setShowJump(false);

    // Proche du haut: charge la page plus ancienne en préservant la position.
    if (
      el.scrollTop <= NEAR_TOP_PX &&
      hasMore &&
      nextBefore != null &&
      !loadingOlderRef.current &&
      !isFetching
    ) {
      loadingOlderRef.current = true;
      prependRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
      onLoadOlder();
    }
  }, [hasMore, nextBefore, isFetching, onLoadOlder]);

  // Effets de scroll après chaque changement de la liste de messages.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // 1) Historique préfixé: ré-applique le delta de hauteur (pas de saut).
    if (prependRef.current) {
      const { scrollHeight, scrollTop } = prependRef.current;
      prependRef.current = null;
      el.scrollTop = scrollTop + (el.scrollHeight - scrollHeight);
      prevCountRef.current = messages.length;
      return;
    }

    // 2) Ouverture de la discussion: scroll instantané tout en bas.
    if (!didInitialScrollRef.current && messages.length > 0) {
      didInitialScrollRef.current = true;
      prevCountRef.current = messages.length;
      scrollToBottom('auto');
      atBottomRef.current = true;
      return;
    }

    // 3) Nouveau(x) message(s) en bas: auto-scroll seulement si déjà en bas.
    const appended = messages.length > prevCountRef.current;
    prevCountRef.current = messages.length;
    if (appended) {
      if (atBottomRef.current) {
        scrollToBottom('auto');
      } else {
        setShowJump(true);
      }
    }
  }, [messages, scrollToBottom]);

  // Re-scroll en bas quand la hauteur du contenu AUGMENTE (image/vidéo chargée
  // après le scroll initial) ET que l'utilisateur était collé au bas. Évite que
  // les derniers messages passent sous la ligne de flottaison à l'ouverture.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let lastHeight = content.offsetHeight;
    const ro = new ResizeObserver(() => {
      const newHeight = content.offsetHeight;
      if (newHeight > lastHeight && atBottomRef.current) {
        scrollToBottom('auto');
      }
      lastHeight = newHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  const onJumpClick = () => {
    scrollToBottom('smooth');
    atBottomRef.current = true;
    setShowJump(false);
  };

  return (
    <div className="msglist" ref={containerRef} onScroll={handleScroll}>
      {loadingOlder && (
        <p className="msglist__loading">Chargement de l'historique…</p>
      )}
      {isLoading && <p className="msglist__info">Chargement des messages…</p>}
      {isError && <p className="msglist__info">{errorLabel}</p>}
      {!isLoading && messages.length === 0 && (
        <p className="msglist__info">{emptyLabel}</p>
      )}
      <div className="msglist__content" ref={contentRef}>
        {messages.map(renderBubble)}
      </div>
      {showJump && (
        <button
          type="button"
          className="msglist__jump"
          onClick={onJumpClick}
          title="Aller aux nouveaux messages"
        >
          ↓ Nouveaux messages
        </button>
      )}
    </div>
  );
}
