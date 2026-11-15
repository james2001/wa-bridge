import { useEffect, useMemo, useRef, useState } from 'react';
import type { WaContactEntry } from '@app/shared-types';
import { useAppDispatch } from '../../app/hooks';
import Avatar from '../../components/Avatar';
import { selectChat } from '../ui/uiSlice';
import { useGetContactsQuery } from './chatsApi';
import { prettyJid } from './utils';

interface Props {
  accountId: string;
  onClose: () => void;
}

// Nombre maximal de résultats affichés (le carnet peut compter des milliers
// d'entrées ; la recherche affine).
const MAX_RESULTS = 200;

// « Nouvelle discussion » : recherche dans le carnet du compte. Choisir un
// contact ouvre simplement la conversation (vide si jamais écrite) : AUCUN
// message n'est envoyé ici.
export default function NewChatModal({ accountId, onClose }: Props) {
  const dispatch = useAppDispatch();
  const { data: contacts, isLoading, isError } = useGetContactsQuery(accountId);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const matches = useMemo(() => {
    const list = contacts ?? [];
    if (!q) return list;
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (digits.length >= 3 && c.jid.split('@')[0].includes(digits)),
    );
  }, [contacts, q, digits]);
  const shown = matches.slice(0, MAX_RESULTS);
  const saved = shown.filter((c) => c.saved);
  const others = shown.filter((c) => !c.saved);

  const open = (c: WaContactEntry) => {
    dispatch(selectChat(c.jid));
    onClose();
  };

  const renderRow = (c: WaContactEntry) => (
    <li key={c.jid}>
      <button type="button" className="newchat__item" onClick={() => open(c)}>
        <Avatar
          name={c.name}
          jid={c.jid}
          avatarUrl={'/api/wa/avatar/' + encodeURIComponent(c.jid)}
          accountId={accountId}
          size="sm"
        />
        <span className="newchat__text">
          <span className="newchat__name">{c.name}</span>
          <span className="newchat__num">{prettyJid(c.jid)}</span>
        </span>
      </button>
    </li>
  );

  return (
    <div
      className="addacct"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Nouvelle discussion"
    >
      <div
        className="addacct__box newchat"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="addacct__close"
          onClick={onClose}
          aria-label="Fermer"
        >
          ✕
        </button>
        <h2 className="addacct__title">Nouvelle discussion</h2>
        <input
          ref={inputRef}
          type="search"
          className="newchat__search"
          placeholder="Nom ou numéro"
          aria-label="Rechercher un contact"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="newchat__list">
          {isLoading && <p className="newchat__empty">Chargement…</p>}
          {isError && (
            <p className="newchat__empty">Impossible de charger le carnet.</p>
          )}
          {!isLoading && !isError && shown.length === 0 && (
            <p className="newchat__empty">Aucun contact trouvé.</p>
          )}
          {saved.length > 0 && (
            <>
              <h3 className="newchat__section">Contacts</h3>
              <ul>{saved.map(renderRow)}</ul>
            </>
          )}
          {others.length > 0 && (
            <>
              <h3 className="newchat__section">
                Autres personnes (pseudo WhatsApp, hors carnet)
              </h3>
              <ul>{others.map(renderRow)}</ul>
            </>
          )}
          {matches.length > MAX_RESULTS && (
            <p className="newchat__empty">
              {matches.length - MAX_RESULTS} autres : affinez la recherche.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
