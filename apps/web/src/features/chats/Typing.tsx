import { useEffect, useState, type ReactNode } from 'react';
import { PresenceKind } from '@app/shared-types';
import type { WaPresence } from '@app/shared-types';
import { useAppSelector } from '../../app/hooks';
import { selectPresence } from '../whatsapp/waSlice';

// « écrit… » : WhatsApp renvoie l'état tant que la personne tape et envoie
// « pause » quand elle s'arrête. Sans nouvelle au bout de 25 s (pause perdue,
// coupure), l'indicateur s'éteint de lui-même.
const TTL_MS = 25_000;

function isTypingKind(p: WaPresence | undefined): boolean {
  return p?.kind === PresenceKind.COMPOSING || p?.kind === PresenceKind.RECORDING;
}

// Présence « écrit / enregistre » encore fraîche pour une discussion, sinon null.
function useTyping(accountId: string, jid: string): WaPresence | null {
  const p = useAppSelector(selectPresence(accountId, jid));
  const typing = isTypingKind(p);
  const at = p?.at ?? 0;
  // Horodatage de la présence déjà expirée (évite Date.now() au rendu).
  const [expiredAt, setExpiredAt] = useState<number | null>(null);
  useEffect(() => {
    if (!typing) return;
    const t = window.setTimeout(() => setExpiredAt(at), TTL_MS);
    return () => window.clearTimeout(t);
  }, [typing, at]);
  return typing && p && expiredAt !== at ? p : null;
}

function typingLabel(p: WaPresence): string {
  const verb = p.kind === PresenceKind.RECORDING ? 'enregistre' : 'écrit';
  return p.participantName ? `${p.participantName} ${verb}…` : `${verb}…`;
}

export function TypingDots() {
  return (
    <span className="typingdots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

// Remplace `children` (aperçu, sous-titre) par « ••• écrit… » le temps
// que la personne écrit.
export function TypingOr({
  accountId,
  jid,
  children,
}: {
  accountId: string;
  jid: string;
  children: ReactNode;
}) {
  const p = useTyping(accountId, jid);
  if (!p) return <>{children}</>;
  return (
    <span className="typing">
      <TypingDots />
      {typingLabel(p)}
    </span>
  );
}

// Bulle « ••• » en bas du fil, posée par-dessus la liste (hors du conteneur
// défilant : ne touche ni au défilement ni à la position de lecture).
export function TypingBubble({ accountId, jid }: { accountId: string; jid: string }) {
  const p = useTyping(accountId, jid);
  if (!p) return null;
  return (
    <div className="typingbubble-anchor">
      <div className="typingbubble" role="status" aria-label={typingLabel(p)}>
        <TypingDots />
        {p.participantName && (
          <span className="typingbubble__name">{p.participantName}</span>
        )}
      </div>
    </div>
  );
}
