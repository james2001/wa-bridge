import { useGetPeopleQuery } from './peopleApi';
import PersonHeader from './PersonHeader';
import PersonTimeline from './PersonTimeline';

interface Props {
  jid: string;
}

// Conversation fusionnée d'une personne (lecture seule, v1). Le compte s'affiche
// sous chaque bulle uniquement si la conversation couvre plusieurs comptes.
export default function PersonView({ jid }: Props) {
  const { data: people } = useGetPeopleQuery();
  const person = people?.find((p) => p.jid === jid);
  const multiAccount = (person?.accountIds.length ?? 0) > 1;

  return (
    <section className="chat">
      <PersonHeader person={person} jid={jid} />
      <PersonTimeline jid={jid} showAccount={multiAccount} />
      <div className="readonly-note">
        Vue fusionnée en lecture seule — pour répondre, ouvrez la discussion
        depuis l'onglet « Comptes ».
      </div>
    </section>
  );
}
