import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ConnectionState, DEFAULT_ACCOUNT_ID } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { selectConnection } from './waSlice';
import { setActiveAccount } from '../ui/uiSlice';
import { createAccount } from '../../services/socket';

interface Props {
  onClose: () => void;
}

// Palette d'accents proposée pour distinguer les comptes.
const COLORS = ['#25D366', '#0A7CFF', '#8E44AD', '#E67E22', '#E84393'];

type Phase = 'form' | 'connecting';

// Modale « Ajouter un compte » : nomme le compte, choisis une couleur, puis
// scanne le QR du nouveau numéro. Bascule automatiquement dessus une fois lié.
export default function AddAccountModal({ onClose }: Props) {
  const dispatch = useAppDispatch();
  const closeRef = useRef<HTMLButtonElement>(null);

  const [phase, setPhase] = useState<Phase>('form');
  const [label, setLabel] = useState('');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Connexion live du nouveau compte (placeholder tant qu'aucun accountId).
  const connection = useAppSelector(
    selectConnection(accountId ?? DEFAULT_ACCOUNT_ID),
  );
  const activeConn = accountId ? connection : null;

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

  // Dès que le nouveau compte est lié : bascule dessus et ferme.
  useEffect(() => {
    if (accountId && activeConn?.state === ConnectionState.OPEN) {
      dispatch(setActiveAccount(accountId));
      const t = setTimeout(onClose, 900);
      return () => clearTimeout(t);
    }
  }, [accountId, activeConn?.state, dispatch, onClose]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const ack = await createAccount(label.trim() || 'Nouveau compte', color);
      if (ack.ok && ack.account) {
        setAccountId(ack.account.id);
        setPhase('connecting');
      } else {
        setError(ack.error ?? 'Création impossible.');
      }
    } catch {
      setError('Le pont est injoignable. Réessaie.');
    } finally {
      setSubmitting(false);
    }
  };

  const linked = activeConn?.state === ConnectionState.OPEN;

  return (
    <div
      className="addacct"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Ajouter un compte"
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

        {phase === 'form' && (
          <form className="addacct__form" onSubmit={onSubmit}>
            <h2 className="addacct__title">Ajouter un compte WhatsApp</h2>
            <label className="addacct__field">
              <span>Nom du compte</span>
              <input
                type="text"
                value={label}
                autoFocus
                maxLength={40}
                placeholder="ex. Perso, Pro, Boutique…"
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <div className="addacct__field">
              <span>Couleur</span>
              <div className="addacct__colors">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={
                      'addacct__color' +
                      (color === c ? ' addacct__color--active' : '')
                    }
                    style={{ background: c }}
                    aria-label={`Couleur ${c}`}
                    aria-pressed={color === c}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </div>
            {error && <p className="addacct__error">{error}</p>}
            <button
              type="submit"
              className="addacct__submit"
              disabled={submitting}
            >
              {submitting ? 'Création…' : 'Continuer'}
            </button>
          </form>
        )}

        {phase === 'connecting' && (
          <div className="addacct__connect">
            <h2 className="addacct__title">
              {linked ? 'Compte lié ✓' : `Lie « ${label.trim() || 'le compte'} »`}
            </h2>
            {linked ? (
              <p className="addacct__hint">Bascule sur le nouveau compte…</p>
            ) : activeConn?.state === ConnectionState.QR && activeConn.qr ? (
              <>
                <div className="addacct__qr">
                  <QRCodeSVG
                    key={activeConn.qr}
                    value={activeConn.qr}
                    size={220}
                    level="M"
                    marginSize={4}
                  />
                </div>
                <ol className="addacct__steps">
                  <li>1. Ouvre WhatsApp sur le téléphone du 2ᵉ numéro</li>
                  <li>2. Appareils connectés &gt; Lier un appareil</li>
                  <li>3. Scanne ce code</li>
                </ol>
              </>
            ) : (
              <>
                <div className="spinner" />
                <p className="addacct__hint">Préparation du QR…</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
