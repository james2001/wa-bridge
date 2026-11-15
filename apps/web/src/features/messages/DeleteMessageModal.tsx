import { useEffect, useRef, useState } from 'react';
import type { WaMessage } from '@app/shared-types';
import { deleteMessage } from '../../services/socket';

interface Props {
  message: WaMessage;
  // « Pour tout le monde » autorisé (son message, < 48 h, pas déjà supprimé).
  canRevoke: boolean;
  onClose: () => void;
}

// Confirmation de suppression (fenêtre de l'application, jamais
// window.confirm). Un seul envoi possible : les boutons se désactivent dès
// le premier clic.
export default function DeleteMessageModal({ message, canRevoke, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Focus sur « Annuler » : Entrée par réflexe ne supprime rien.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const run = async (scope: 'me' | 'everyone') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const ack = await deleteMessage(
        message.accountId,
        message.chatJid,
        message.id,
        scope,
      );
      if (ack.ok) {
        onClose();
        return;
      }
      setError(ack.error ?? 'Échec de la suppression');
    } catch {
      setError('WhatsApp injoignable, rien n’a été supprimé');
    }
    setBusy(false);
  };

  const excerpt = message.text
    ? message.text.length > 80
      ? message.text.slice(0, 77) + '…'
      : message.text
    : 'ce message';

  return (
    <div
      className="addacct"
      onClick={() => !busy && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="Supprimer le message"
    >
      <div className="addacct__box delmsg" onClick={(e) => e.stopPropagation()}>
        <h2 className="addacct__title">Supprimer le message ?</h2>
        <p className="delmsg__excerpt">« {excerpt} »</p>
        {canRevoke && (
          <p className="delmsg__hint">
            « Pour tout le monde » : votre contact verra « Ce message a été
            supprimé ».
          </p>
        )}
        {error && (
          <p className="delmsg__error" role="alert">
            {error}
          </p>
        )}
        <div className="delmsg__actions">
          {canRevoke && (
            <button
              type="button"
              className="btn btn--sm delmsg__danger"
              disabled={busy}
              onClick={() => void run('everyone')}
            >
              Supprimer pour tout le monde
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm delmsg__danger"
            disabled={busy}
            onClick={() => void run('me')}
          >
            Supprimer pour moi
          </button>
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--sm delmsg__cancel"
            disabled={busy}
            onClick={onClose}
          >
            Annuler
          </button>
        </div>
      </div>
    </div>
  );
}
