import type { WaMessageStatus } from '@app/shared-types';
import { isReadStatus, statusMark } from '../lib/statusMark';

interface Props {
  status: WaMessageStatus | null | undefined;
  // Groupe : lu par au moins un membre, pas par tous.
  partialRead?: boolean;
  // Classe de base (bubble__check, convitem__check) ; « --read » = bleu.
  className: string;
}

// Coches d'un message sortant. En groupe : double bleu quand TOUS ont lu,
// une bleue + une grise dès qu'au moins un a lu, sinon grises.
export default function Ticks({ status, partialRead, className }: Props) {
  const read = isReadStatus(status);
  if (!read && partialRead) {
    return (
      <span className={className} title="Lu par une partie des membres">
        <span className={`${className}--read`}>✓</span>✓
      </span>
    );
  }
  return (
    <span className={className + (read ? ` ${className}--read` : '')}>
      {statusMark(status)}
    </span>
  );
}
