import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { WaMessage } from '@app/shared-types';
import { useGetMessagesQuery } from './messagesApi';
import MessageBubble from './MessageBubble';

interface Props {
  jid: string;
}

// Seuil (px) sous lequel on considère l'utilisateur « collé » au bas: en
// dessous, un nouveau message déclenche l'auto-scroll.
const NEAR_BOTTOM_PX = 150;
// Seuil (px) du haut déclenchant le chargement de l'historique plus ancien.
const NEAR_TOP_PX = 80;

export default function MessageList({ jid }: Props) {
  // `before` pilote la pagination: undefined = page la plus récente.
  const [before, setBefore] = useState<number | undefined>(undefined);
  const { data, isLoading, isError, isFetching } = useGetMessagesQuery({
    jid,
    before,
  });

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

  const messages = useMemo(
    () =>
      data ? [...data.messages].sort((a, b) => a.timestamp - b.timestamp) : [],
    [data],
  );

  // Index id -> message pour résoudre l'aperçu d'une réponse citée (quotedId).
  const messagesById = useMemo(() => {
    const map = new Map<string, WaMessage>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  const hasMore = data?.hasMore ?? false;
  const nextBefore = data?.nextBefore ?? null;

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Réinitialise l'état dérivé quand on change de discussion (sécurité même si
  // le composant est normalement remonté via la `key` du ChatView).
  useEffect(() => {
    didInitialScrollRef.current = false;
    atBottomRef.current = true;
    loadingOlderRef.current = false;
    prevCountRef.current = 0;
    setBefore(undefined);
    setShowJump(false);
  }, [jid]);

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
      setBefore(nextBefore);
    }
  }, [hasMore, nextBefore, isFetching]);

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
      {isFetching && before != null && (
        <p className="msglist__loading">Chargement de l'historique…</p>
      )}
      {isLoading && <p className="msglist__info">Chargement des messages…</p>}
      {isError && (
        <p className="msglist__info">Impossible de charger les messages.</p>
      )}
      {!isLoading && messages.length === 0 && (
        <p className="msglist__info">Aucun message dans cette discussion.</p>
      )}
      <div className="msglist__content" ref={contentRef}>
        {messages.map((m) => (
          <MessageBubble
            key={m.clientId ?? m.id}
            message={m}
            quoted={m.quotedId ? messagesById.get(m.quotedId) ?? null : null}
          />
        ))}
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
