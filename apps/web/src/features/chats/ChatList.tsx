import { useEffect, useMemo, useState } from 'react';
import type { WaAccount, WaChat } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { initials, formatChatTime } from '../../lib/format';
import Avatar from '../../components/Avatar';
import { useGetChatsQuery, useGetCommunitiesQuery } from './chatsApi';
import { chatTitle, prettyJid } from './utils';
import {
  selectActiveAccountId,
  selectChat,
  setActiveAccount,
  selectSelectedChatJid,
} from '../ui/uiSlice';
import {
  selectAccounts,
  selectConnection,
  selectDefaultAccountId,
} from '../whatsapp/waSlice';
import AccountBar from '../whatsapp/AccountBar';
import AddAccountModal from '../whatsapp/AddAccountModal';
import RelinkAccountModal from '../whatsapp/RelinkAccountModal';
import ViewModeToggle from '../whatsapp/ViewModeToggle';
import { useLogoutMutation } from '../auth/authApi';

type ChatFilter = 'all' | 'unread' | 'groups';

// WhatsApp: unreadCount > 0 = nb de non-lus ; === -1 = "marqué non lu" (sans
// nombre) ; 0 = lu. On considère "non lu" les deux premiers cas.
const isUnread = (c: WaChat) => c.unreadCount > 0 || c.unreadCount === -1;

export default function ChatList() {
  const dispatch = useAppDispatch();
  const activeAccountId = useAppSelector(selectActiveAccountId);
  const { data: chats, isLoading, isError } = useGetChatsQuery(activeAccountId);
  const selectedJid = useAppSelector(selectSelectedChatJid);
  const connection = useAppSelector(selectConnection(activeAccountId));
  const accounts = useAppSelector(selectAccounts);
  const defaultAccountId = useAppSelector(selectDefaultAccountId);
  const [logout] = useLogoutMutation();

  // Réconcilie le compte actif si celui-ci disparaît (suppression reçue par
  // broadcast, ou ACK de suppression en échec côté initiateur) -> repli sur le
  // compte principal. Évite de rester coincé sur un compte fantôme.
  useEffect(() => {
    if (
      accounts.length > 0 &&
      !accounts.some((a) => a.id === activeAccountId)
    ) {
      dispatch(setActiveAccount(defaultAccountId));
    }
  }, [accounts, activeAccountId, defaultAccountId, dispatch]);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ChatFilter>('all');
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [relinkAccount, setRelinkAccount] = useState<WaAccount | null>(null);
  // Communautés (regroupement des groupes dans l'onglet « Groupes »).
  const { data: communities } = useGetCommunitiesQuery(activeAccountId);
  const communitiesById = useMemo(
    () => new Map((communities ?? []).map((c) => [c.jid, c])),
    [communities],
  );
  // Communautés repliées (par défaut toutes dépliées). Clé scopée au compte
  // actif : un même JID de communauté peut exister sur 2 comptes (pas de fuite).
  const [collapsedCommunities, setCollapsedCommunities] = useState<Set<string>>(
    () => new Set(),
  );
  const commKey = (cjid: string) => `${activeAccountId} ${cjid}`;
  const toggleCommunity = (cjid: string) => {
    const key = commKey(cjid);
    setCollapsedCommunities((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Nom affiché en tête: nom WhatsApp du compte actif, sinon son libellé.
  const activeLabel = accounts.find((a) => a.id === activeAccountId)?.label;
  const meName =
    connection.me?.name ||
    (connection.me ? prettyJid(connection.me.jid) : activeLabel || 'Moi');

  const sorted = useMemo(
    () =>
      chats
        ? [...chats].sort(
            (a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0),
          )
        : [],
    [chats],
  );

  const active = useMemo(() => sorted.filter((c) => !c.archived), [sorted]);
  const archived = useMemo(() => sorted.filter((c) => c.archived), [sorted]);

  // Compteurs des onglets (sur les discussions non archivées).
  const unreadCount = useMemo(
    () => active.filter(isUnread).length,
    [active],
  );
  const groupCount = useMemo(
    () => active.filter((c) => c.isGroup).length,
    [active],
  );

  const q = query.trim().toLowerCase();

  // Liste principale: filtre d'onglet + recherche (titre ou numéro).
  const visibleActive = useMemo(
    () =>
      active.filter((c) => {
        if (filter === 'unread' && !isUnread(c)) return false;
        if (filter === 'groups' && !c.isGroup) return false;
        if (!q) return true;
        return (
          chatTitle(c).toLowerCase().includes(q) ||
          prettyJid(c.jid).toLowerCase().includes(q)
        );
      }),
    [active, filter, q],
  );

  // Archivées: mêmes critères (onglet + recherche) que la liste principale,
  // pour rester cohérent avec l'onglet actif.
  const visibleArchived = useMemo(
    () =>
      archived.filter((c) => {
        if (filter === 'unread' && !isUnread(c)) return false;
        if (filter === 'groups' && !c.isGroup) return false;
        if (!q) return true;
        return (
          chatTitle(c).toLowerCase().includes(q) ||
          prettyJid(c.jid).toLowerCase().includes(q)
        );
      }),
    [archived, filter, q],
  );

  // Section archivées visible en vue "Toutes" ou pendant une recherche.
  const showArchivedSection =
    visibleArchived.length > 0 && (filter === 'all' || q.length > 0);
  // Déplie automatiquement les archivées pendant une recherche (sinon un
  // résultat uniquement archivé resterait caché derrière l'en-tête replié).
  const archivedExpanded = showArchived || q.length > 0;

  const filters: { key: ChatFilter; label: string; count: number }[] = [
    { key: 'all', label: 'Toutes', count: 0 },
    { key: 'unread', label: 'Non lues', count: unreadCount },
    { key: 'groups', label: 'Groupes', count: groupCount },
  ];

  const renderItem = (c: WaChat) => {
    const title = chatTitle(c);
    return (
      <button
        key={c.jid}
        className={
          'convitem' + (c.jid === selectedJid ? ' convitem--active' : '')
        }
        onClick={() => {
          // Comme WhatsApp Web: ouvrir un résultat vide la recherche.
          setQuery('');
          dispatch(selectChat(c.jid));
        }}
      >
        <Avatar
          name={title}
          jid={c.jid}
          avatarUrl={c.avatarUrl}
          accountId={c.accountId}
        />
        <div className="convitem__body">
          <div className="convitem__top">
            <span className="convitem__title">
              {c.isAnnounce && (
                <span
                  className="convitem__announce"
                  title="Annonces de la communauté"
                >
                  📢
                </span>
              )}
              {c.muted && (
                <span className="convitem__muted" title="Notifications coupées">
                  🔇
                </span>
              )}
              {title}
            </span>
            <span className="convitem__time">
              {formatChatTime(c.lastMessageTs)}
            </span>
          </div>
          <div className="convitem__bottom">
            <span className="convitem__preview">
              {c.lastMessagePreview ?? ''}
            </span>
            {c.unreadCount > 0 && (
              <span className="badge">{c.unreadCount}</span>
            )}
            {c.unreadCount === -1 && (
              <span
                className="badge badge--dot"
                title="Marqué comme non lu"
              />
            )}
          </div>
        </div>
      </button>
    );
  };

  // Regroupement des groupes par communauté (onglet « Groupes »). Chaque
  // communauté = en-tête repliable (groupe d'annonces d'abord) ; les groupes
  // hors communauté sont affichés à plat en dessous.
  const renderGroupsGrouped = (groups: WaChat[]) => {
    const byCommunity = new Map<string, WaChat[]>();
    const standalone: WaChat[] = [];
    for (const g of groups) {
      if (g.communityJid) {
        const arr = byCommunity.get(g.communityJid);
        if (arr) arr.push(g);
        else byCommunity.set(g.communityJid, [g]);
      } else {
        standalone.push(g);
      }
    }
    const entries = [...byCommunity.entries()].sort((a, b) =>
      (communitiesById.get(a[0])?.name ?? a[0]).localeCompare(
        communitiesById.get(b[0])?.name ?? b[0],
      ),
    );
    return (
      <>
        {entries.map(([cjid, gs]) => {
          const comm = communitiesById.get(cjid);
          const cname = comm?.name ?? 'Communauté';
          const collapsed = collapsedCommunities.has(commKey(cjid));
          // Groupe d'annonces d'abord, puis par récence.
          const sorted = [...gs].sort(
            (a, b) =>
              (b.isAnnounce ? 1 : 0) - (a.isAnnounce ? 1 : 0) ||
              (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0),
          );
          return (
            <div className="community" key={cjid}>
              <button
                type="button"
                className="community__header"
                aria-expanded={!collapsed}
                onClick={() => toggleCommunity(cjid)}
              >
                <Avatar
                  name={cname}
                  jid={cjid}
                  avatarUrl={comm?.avatarUrl ?? null}
                  accountId={activeAccountId}
                  size="sm"
                />
                <span className="community__title">{cname}</span>
                <span className="community__count">{gs.length}</span>
                <span className="community__chevron">
                  {collapsed ? '▸' : '▾'}
                </span>
              </button>
              {!collapsed && (
                <div className="community__groups">{sorted.map(renderItem)}</div>
              )}
            </div>
          );
        })}
        {standalone.map(renderItem)}
      </>
    );
  };

  return (
    <aside className="sidebar">
      <header className="sidebar__header">
        <div className="sidebar__me">
          <div className="avatar avatar--sm">{initials(meName)}</div>
          <span>{meName}</span>
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
          aria-label="Rechercher une discussion"
          placeholder="Rechercher une discussion"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
      </div>

      <div className="filterbar">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            className={
              'filterchip' + (filter === f.key ? ' filterchip--active' : '')
            }
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.count > 0 && <span className="filterchip__count">{f.count}</span>}
          </button>
        ))}
      </div>

      <div className="sidebar__list">
        {isLoading && <p className="sidebar__empty">Chargement…</p>}
        {isError && (
          <p className="sidebar__empty">
            Impossible de charger les discussions.
          </p>
        )}

        {showArchivedSection && (
          <button
            className="archived-toggle"
            onClick={() => setShowArchived((v) => !v)}
          >
            <span className="archived-toggle__icon">🗄</span>
            <span className="archived-toggle__label">
              Archivées ({visibleArchived.length})
            </span>
            <span className="archived-toggle__chevron">
              {archivedExpanded ? '▾' : '▸'}
            </span>
          </button>
        )}
        {showArchivedSection &&
          archivedExpanded &&
          visibleArchived.map(renderItem)}

        {filter === 'groups'
          ? renderGroupsGrouped(visibleActive)
          : visibleActive.map(renderItem)}

        {!isLoading &&
          !isError &&
          visibleActive.length === 0 &&
          !showArchivedSection && (
            <p className="sidebar__empty">
              {q || filter !== 'all'
                ? 'Aucun résultat.'
                : 'Aucune discussion pour le moment.'}
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
