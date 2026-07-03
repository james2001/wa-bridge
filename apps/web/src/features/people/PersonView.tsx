import { useEffect } from 'react';
import { useAppSelector } from '../../app/hooks';
import { selectAccounts } from '../whatsapp/waSlice';
import { useGetPeopleQuery } from './peopleApi';
import Composer from '../messages/Composer';
import { markRead } from '../../services/socket';
import PersonHeader from './PersonHeader';
import PersonTimeline from './PersonTimeline';

interface Props {
  jid: string;
}

// Conversation fusionnée d'une personne. Le compte s'affiche sous chaque bulle
// uniquement si la conversation couvre plusieurs comptes. On peut répondre en
// choisissant le compte émetteur (défaut = compte le plus récent de la personne).
export default function PersonView({ jid }: Props) {
  const { data: people } = useGetPeopleQuery();
  const accounts = useAppSelector(selectAccounts);
  const person = people?.find((p) => p.jid === jid);
  const multiAccount = (person?.accountIds.length ?? 0) > 1;

  // La vue fusionnée est interactive (composer) : lire une personne doit remettre
  // ses non-lus à 0 — comme la vue par compte. On marque lu sur CHAQUE compte de
  // la personne à l'ouverture ; PersonTimeline gère les entrants pendant l'affichage.
  const accountIdsKey = person?.accountIds.join(',') ?? '';
  useEffect(() => {
    if (!accountIdsKey) return;
    for (const acc of accountIdsKey.split(',')) markRead(acc, jid);
  }, [jid, accountIdsKey]);

  // Comptes candidats à l'envoi, compte primaire (dernier actif) en tête.
  const options = person
    ? [
        ...accounts.filter((a) => a.id === person.primaryAccountId),
        ...accounts.filter(
          (a) =>
            a.id !== person.primaryAccountId &&
            person.accountIds.includes(a.id),
        ),
      ]
    : [];

  return (
    <section className="chat">
      <PersonHeader person={person} jid={jid} />
      <PersonTimeline jid={jid} showAccount={multiAccount} />
      {options.length > 0 ? (
        <Composer chatJid={jid} accountId={options[0].id} accountOptions={options} />
      ) : (
        <div className="readonly-note">Chargement du compte…</div>
      )}
    </section>
  );
}
