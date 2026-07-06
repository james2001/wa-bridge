import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ConnectionState } from '@app/shared-types';
import type { WaAccount } from '@app/shared-types';
import { useAppSelector } from '../../app/hooks';
import { selectConnection } from './waSlice';
import { waLogout } from '../../services/socket';

interface Props {
  account: WaAccount;
  onClose: () => void;
}

// Modale « Re-lier un compte » : délie la session WhatsApp courante (les
// discussions locales sont conservées) puis affiche le nouveau QR à scanner.
// Utile quand une session est corrompue (messages qui n'arrivent plus) sans
// passer par la suppression du compte. Réutilise les styles de AddAccountModal.
export default function RelinkAccountModal({ account, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const connection = useAppSelector(selectConnection(account.id));
  const [error, setError] = useState<string | null>(null);
  // La connexion démarre à OPEN (ancienne session) : on ne considère OPEN
  // comme « re-lié » qu'après être passé par un état non-OPEN (logout/QR).
  const [leftOpen, setLeftOpen] = useState(false);

  // Déliaison au montage (une seule fois — StrictMode-safe via ref).
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    waLogout(account.id).catch(() => {
      setError('La déliaison a échoué. Réessaie.');
    });
  }, [account.id]);

  useEffect(() => {
    if (connection.state !== ConnectionState.OPEN) setLeftOpen(true);
  }, [connection.state]);

  const linked = leftOpen && connection.state === ConnectionState.OPEN;

  // A11y : focus dans la modale + Échap pour fermer.
  useEffect(() => {
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

  // Dès que le compte est re-lié : ferme après un court feedback visuel.
  useEffect(() => {
    if (linked) {
      const t = setTimeout(onClose, 900);
      return () => clearTimeout(t);
    }
  }, [linked, onClose]);

  const body = () => {
    if (error) return <p className="addacct__error">{error}</p>;
    if (linked) {
      return <p className="addacct__hint">Compte re-lié, messages en cours de resynchronisation…</p>;
    }
    if (connection.state === ConnectionState.QR && connection.qr) {
      return (
        <>
          <div className="addacct__qr">
            <QRCodeSVG
              key={connection.qr}
              value={connection.qr}
              size={220}
              level="M"
              marginSize={4}
            />
          </div>
          <ol className="addacct__steps">
            <li>1. Ouvre WhatsApp sur le téléphone de ce compte</li>
            <li>2. Appareils connectés &gt; Lier un appareil</li>
            <li>3. Scanne ce code</li>
          </ol>
        </>
      );
    }
    return (
      <>
        <div className="spinner" />
        <p className="addacct__hint">
          {leftOpen ? 'Préparation du QR…' : 'Déliaison de la session…'}
        </p>
      </>
    );
  };

  return (
    <div
      className="addacct"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Re-lier ${account.label}`}
    >
      <div className="addacct__box" onClick={(e) => e.stopPropagation()}>
        <button
          ref={closeRef}
          type="button"
          className="addacct__close"
          onClick={onClose}
          aria-label="Fermer"
        >
          ✕
        </button>
        <div className="addacct__connect">
          <h2 className="addacct__title">
            {linked ? 'Compte re-lié ✓' : `Re-lie « ${account.label} »`}
          </h2>
          {body()}
        </div>
      </div>
    </div>
  );
}
