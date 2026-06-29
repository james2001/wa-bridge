import { useEffect } from 'react';
import { useAppDispatch } from '../../app/hooks';
import Avatar from '../../components/Avatar';
import MediaGallery from './MediaGallery';
import { useGetChatsQuery, useGetChatMediaQuery } from './chatsApi';
import { chatTitle, prettyJid } from './utils';
import { closeInfoPanel } from '../ui/uiSlice';

interface Props {
  jid: string;
}

// Volet latéral droit « Infos » (façon WhatsApp Web): identité du contact /
// groupe puis section « Médias, liens et documents » avec la galerie.
export default function ContactInfoPanel({ jid }: Props) {
  const dispatch = useAppDispatch();
  const { data: chats } = useGetChatsQuery();
  const chat = chats?.find((c) => c.jid === jid);
  const { data: media } = useGetChatMediaQuery(jid);

  const title = chat ? chatTitle(chat) : prettyJid(jid);
  const isGroup = chat?.isGroup ?? jid.endsWith('@g.us');
  // Pour un 1:1 on affiche le numéro ; pour un groupe, le sujet EST le titre.
  const subtitle = isGroup ? 'Groupe' : prettyJid(jid);
  const mediaCount = media?.length ?? 0;

  // Échap ferme le panneau — sauf si une lightbox est ouverte (qui gère son
  // propre Échap), pour ne pas fermer les deux d'un coup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.lightbox')) {
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
              size="lg"
            />
          </div>
          <h2 className="infopanel__name">{title}</h2>
          <span className="infopanel__sub">{subtitle}</span>
        </section>

        <section className="infopanel__media">
          <div className="infopanel__media-head">
            <span>Médias, liens et documents</span>
            <span className="infopanel__media-count">{mediaCount}</span>
          </div>
          <MediaGallery jid={jid} />
        </section>
      </div>
    </aside>
  );
}
