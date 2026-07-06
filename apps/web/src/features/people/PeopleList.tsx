import { useMemo, useState } from 'react';
import type { WaAccount, WaPerson } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { initials, formatChatTime } from '../../lib/format';
import Avatar from '../../components/Avatar';
import { prettyJid } from '../chats/utils';
import { selectPerson, selectSelectedPersonId } from '../ui/uiSlice';
import { selectAccounts } from '../whatsapp/waSlice';
import { useGetPeopleQuery } from './peopleApi';
import ViewModeToggle from '../whatsapp/ViewModeToggle';
import AccountBar from '../whatsapp/AccountBar';
import AddAccountModal from '../whatsapp/AddAccountModal';
import RelinkAccountModal from '../whatsapp/RelinkAccountModal';
import { useLogoutMutation } from '../auth/authApi';

// Boîte de réception fusionnée : une entrée par personne, tous comptes confondus.
export default function PeopleList() {
  const dispatch = useAppDispatch();
  const { data: people, isLoading, isError } = useGetPeopleQuery();
  const selectedPersonId = useAppSelector(selectSelectedPersonId);
  const accounts = useAppSelector(selectAccounts);
  const [logout] = useLogoutMutation();
  const [query, setQuery] = useState('');
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [relinkAccount, setRelinkAccount] = useState<WaAccount | null>(null);

  const q = query.trim().toLowerCase();
  const acctById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );

  // Personnes actives (au moins une discussion non archivée), filtrées par la
  // recherche, récentes d'abord.
  const visible = useMemo(() => {
    const list = (people ?? [])
      .filter((p) => !p.archived)
      .filter((p) => {
        if (!q) return true;
        return (
          (p.name?.toLowerCase().includes(q) ?? false) ||
          prettyJid(p.jid).toLowerCase().includes(q)
        );
      });
    return [...list].sort(
      (a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0),
    );
  }, [people, q]);

  const renderItem = (p: WaPerson) => {
    const title = p.name ?? prettyJid(p.jid);
    const multi = p.accountIds.length > 1;
    return (
      <button
        key={p.jid}
        className={
          'convitem' + (p.jid === selectedPersonId ? ' convitem--active' : '')
        }
        onClick={() => {
          setQuery('');
          dispatch(selectPerson(p.jid));
        }}
      >
        <Avatar
          name={title}
          jid={p.jid}
          avatarUrl={p.avatarUrl}
          accountId={p.primaryAccountId}
        />
        <div className="convitem__body">
          <div className="convitem__top">
            <span className="convitem__title">
              {p.muted && (
                <span className="convitem__muted" title="Notifications coupées">
                  🔇
                </span>
              )}
              {title}
            </span>
            <span className="convitem__time">
              {formatChatTime(p.lastMessageTs)}
            </span>
          </div>
          <div className="convitem__bottom">
            <span className="convitem__preview">
              {p.lastMessagePreview ?? ''}
            </span>
            {multi && (
              <span
                className="convitem__accts"
                title={p.accountIds
                  .map((id) => acctById.get(id)?.label ?? id)
                  .join(' · ')}
              >
                {p.accountIds.map((id) => {
                  const acc = acctById.get(id);
                  return (
                    <span
                      key={id}
                      className="convitem__acctdot"
                      style={acc?.color ? { background: acc.color } : undefined}
                    />
                  );
                })}
              </span>
            )}
            {p.unreadCount > 0 && <span className="badge">{p.unreadCount}</span>}
            {p.unreadCount === -1 && (
              <span className="badge badge--dot" title="Marqué comme non lu" />
            )}
          </div>
        </div>
      </button>
    );
  };

  return (
    <aside className="sidebar">
      <header className="sidebar__header">
        <div className="sidebar__me">
          <div className="avatar avatar--sm">{initials('Fusionné')}</div>
          <span>Toutes les personnes</span>
        </div>
        <div className="sidebar__actions">
          <button
            className="iconbtn"
            title="Se déconnecter"
            onClick={() => {
              void logout();
            }}
          >
            ⎋
          </button>
        </div>
      </header>

      <ViewModeToggle />
      <AccountBar
        onAdd={() => setShowAddAccount(true)}
        onRelink={setRelinkAccount}
      />

      <div className="sidebar__search">
        <input
          type="search"
          aria-label="Rechercher une personne"
          placeholder="Rechercher une personne"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
      </div>

      <div className="sidebar__list">
        {isLoading && <p className="sidebar__empty">Chargement…</p>}
        {isError && (
          <p className="sidebar__empty">Impossible de charger les personnes.</p>
        )}
        {visible.map(renderItem)}
        {!isLoading && !isError && visible.length === 0 && (
          <p className="sidebar__empty">
            {q ? 'Aucun résultat.' : 'Aucune personne pour le moment.'}
          </p>
        )}
      </div>

      {showAddAccount && (
        <AddAccountModal onClose={() => setShowAddAccount(false)} />
      )}
      {relinkAccount && (
        <RelinkAccountModal
          account={relinkAccount}
          onClose={() => setRelinkAccount(null)}
        />
      )}
    </aside>
  );
}
