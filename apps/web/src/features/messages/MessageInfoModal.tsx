import { useEffect, useRef } from 'react';
import { WaMessageStatus } from '@app/shared-types';
import type { WaMessage, WaMessageReceipt } from '@app/shared-types';
import { prettyJid } from '../chats/utils';
import { useGetMessageInfoQuery } from './messagesApi';

// Repli quand aucun accusé PAR destinataire n'a été capturé (ex. messages
// antérieurs à l'introduction du suivi des receipts) : on s'appuie sur le
// statut agrégé du message, sinon on afficherait « en attente » alors que la
// bulle montre ✓✓.
function fallbackState(status: WaMessageStatus): string {
  switch (status) {
    case WaMessageStatus.READ:
    case WaMessageStatus.PLAYED:
      return 'Lu';
    case WaMessageStatus.DELIVERED:
      return 'Distribué';
    case WaMessageStatus.PENDING:
      return 'En cours d’envoi…';
    case WaMessageStatus.ERROR:
      return 'Échec de l’envoi';
    default:
      return 'En attente de distribution…';
  }
}

interface Props {
  message: WaMessage;
  onClose: () => void;
}

// Date + heure complète (fr) à partir d'un epoch ms. Pas de helper global pour
// ce format détaillé: on le construit localement au modal.
function formatDateTime(ts: number | null | undefined): string {
  if (ts == null) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Une étape d'accusé (libellé + heure), affichée seulement si l'horodatage existe.
function Step({ label, ts }: { label: string; ts: number | null }) {
  if (ts == null) return null;
  return (
    <div className="msginfo__step">
      <span className="msginfo__step-label">{label}</span>
      <span className="msginfo__step-time">{formatDateTime(ts)}</span>
    </div>
  );
}

// Bloc d'un destinataire: nom (en groupe) + étapes franchies (lu/distribué/écouté).
function ReceiptRow({
  receipt,
  showName,
}: {
  receipt: WaMessageReceipt;
  showName: boolean;
}) {
  const name = receipt.name ?? prettyJid(receipt.userJid);
  const pending =
    receipt.readAt == null &&
    receipt.deliveredAt == null &&
    receipt.playedAt == null;
  return (
    <div className="msginfo__row">
      {showName && <span className="msginfo__name">{name}</span>}
      <Step label="Lu" ts={receipt.readAt} />
      <Step label="Distribué" ts={receipt.deliveredAt} />
      <Step label="Écouté" ts={receipt.playedAt} />
      {pending && (
        <span className="msginfo__state">En attente de distribution…</span>
      )}
    </div>
  );
}

// Modale « Infos du message »: accusés de réception d'un message sortant.
// A11y calquée sur la Lightbox (focus piégé sur ✕, Échap, clic overlay = ferme).
export default function MessageInfoModal({ message, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const { data, isLoading, isError } = useGetMessageInfoQuery({
    accountId: message.accountId,
    jid: message.chatJid,
    id: message.id,
  });

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

  const sentAt = data?.sentAt ?? message.timestamp;
  // En groupe, on coiffe chaque bloc du nom du destinataire.
  const isGroup = data?.isGroup ?? false;

  return (
    <div
      className="msginfo"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Infos du message"
    >
      <div className="msginfo__box" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          ref={closeRef}
          className="msginfo__close"
          onClick={onClose}
          aria-label="Fermer"
        >
          ✕
        </button>
        <h2 className="msginfo__title">Infos du message</h2>

        <div className="msginfo__row">
          <span className="msginfo__name">Envoyé</span>
          <div className="msginfo__step">
            <span className="msginfo__step-time">{formatDateTime(sentAt)}</span>
          </div>
        </div>

        {isLoading && <p className="msginfo__state">Chargement…</p>}
        {isError && (
          <p className="msginfo__state">Impossible de charger les infos.</p>
        )}

        {data && data.receipts.length === 0 && (
          <p className="msginfo__state">{fallbackState(message.status)}</p>
        )}

        {data?.receipts.map((receipt) => (
          <ReceiptRow
            key={receipt.userJid}
            receipt={receipt}
            showName={isGroup}
          />
        ))}
      </div>
    </div>
  );
}
