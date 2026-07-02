import type { WaPerson } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import Avatar from '../../components/Avatar';
import { prettyJid } from '../chats/utils';
import { selectPerson } from '../ui/uiSlice';
import { selectAccounts } from '../whatsapp/waSlice';

interface Props {
  person: WaPerson | undefined;
  jid: string;
}

// En-tête d'une personne en vue fusionnée. Non interactif (pas de volet infos ni
// d'actions mute/archive, spécifiques à un compte) : sous-titre = comptes couverts.
export default function PersonHeader({ person, jid }: Props) {
  const dispatch = useAppDispatch();
  const accounts = useAppSelector(selectAccounts);
  const title = person?.name ?? prettyJid(jid);
  const labels = (person?.accountIds ?? []).map(
    (id) => accounts.find((a) => a.id === id)?.label ?? id,
  );
  const subtitle =
    labels.length > 1
      ? `Fusionné · ${labels.join(' · ')}`
      : labels[0] ?? prettyJid(jid);

  return (
    <header className="chathdr">
      <button
        className="iconbtn chathdr__back"
        title="Retour"
        onClick={() => dispatch(selectPerson(null))}
      >
        ‹
      </button>
      <div className="chathdr__id chathdr__id--static">
        <Avatar
          name={title}
          jid={jid}
          avatarUrl={person?.avatarUrl ?? null}
          accountId={person?.primaryAccountId}
          size="sm"
        />
        <div className="chathdr__info">
          <span className="chathdr__title">{title}</span>
          <span className="chathdr__status">{subtitle}</span>
        </div>
      </div>
    </header>
  );
}
