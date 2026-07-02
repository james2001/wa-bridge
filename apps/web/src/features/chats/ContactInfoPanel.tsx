import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import Avatar from '../../components/Avatar';
import MediaGallery from './MediaGallery';
import {
  useGetChatsQuery,
  useGetChatMediaQuery,
  useGetContactAboutQuery,
} from './chatsApi';
import { chatTitle, prettyJid } from './utils';
import { formatChatTime } from '../../lib/format';
import { blockChat } from '../../services/socket';
import { closeInfoPanel, selectActiveAccountId } from '../ui/uiSlice';

interface Props {
  jid: string;
}

// Volet latéral droit « Infos » (façon WhatsApp Web): identité du contact /
// groupe puis section « Médias, liens et documents » avec la galerie.
export default function ContactInfoPanel({ jid }: Props) {
  const dispatch = useAppDispatch();
  const accountId = useAppSelector(selectActiveAccountId);
  const { data: chats } = useGetChatsQuery(accountId);
  const chat = chats?.find((c) => c.jid === jid);
  const { data: media } = useGetChatMediaQuery({ accountId, jid });

  const title = chat ? chatTitle(chat) : prettyJid(jid);
  const isGroup = chat?.isGroup ?? jid.endsWith('@g.us');
  // Pour un 1:1 on affiche le numéro ; pour un groupe, le sujet EST le titre.
  const subtitle = isGroup ? 'Groupe' : prettyJid(jid);
  const mediaCount = media?.length ?? 0;

  // Bio « À propos » : 1:1 uniquement (inutile de requêter pour un groupe).
  const { data: about } = useGetContactAboutQuery(
    { accountId, jid },
    { skip: isGroup },
  );
  const blocked = chat?.blocked ?? false;

  // Bascule blocage : confirmation avant de bloquer (évite un clic accidentel).
  const onToggleBlock = () => {
    if (!blocked && !window.confirm(`Bloquer ${title} ?`)) return;
    blockChat(accountId, jid, !blocked);
  };

  // Échap ferme le panneau — sauf si une couche modale est ouverte par-dessus
  // (lightbox média ou modale « Infos du message »), qui gère son propre Échap,
  // pour ne pas tout fermer d'un coup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.lightbox, .msginfo')) {
        dispatch(closeInfoPanel());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dispatch]);

  return (
    <aside className="infopanel" id="info-panel">
      <header className="infopanel__header">
        <button
          type="button"
          className="iconbtn"
          title="Fermer"
          aria-label="Fermer"
          onClick={() => dispatch(closeInfoPanel())}
        >
          ✕
        </button>
        <span className="infopanel__header-title">
          {isGroup ? 'Infos du groupe' : 'Infos du contact'}
        </span>
      </header>

      <div className="infopanel__scroll">
        <section className="infopanel__id">
          <div className="infopanel__avatar">
            <Avatar
              name={title}
              jid={jid}
              avatarUrl={chat?.avatarUrl ?? null}
              accountId={accountId}
              size="lg"
            />
          </div>
          <h2 className="infopanel__name">{title}</h2>
          <span className="infopanel__sub">{subtitle}</span>
        </section>

        {/* « À propos » : 1:1 uniquement, masqué si aucun statut disponible. */}
        {!isGroup && about?.status && (
          <section className="infopanel__about">
            <div className="infopanel__media-head">
              <span>À propos</span>
            </div>
            <p className="infopanel__about-text">{about.status}</p>
            {about.setAt != null && (
              <span className="infopanel__about-date">
                Mis à jour le {formatChatTime(about.setAt)}
              </span>
            )}
          </section>
        )}

        <section className="infopanel__media">
          <div className="infopanel__media-head">
            <span>Médias, liens et documents</span>
            <span className="infopanel__media-count">{mediaCount}</span>
          </div>
          <MediaGallery jid={jid} accountId={accountId} />
        </section>

        {/* Zone d'actions : blocage du contact (1:1 uniquement). */}
        {!isGroup && (
          <section className="infopanel__actions">
            <button
              type="button"
              className="infopanel__block"
              onClick={onToggleBlock}
            >
              {blocked ? 'Débloquer' : 'Bloquer'}
            </button>
          </section>
        )}
      </div>
    </aside>
  );
}
