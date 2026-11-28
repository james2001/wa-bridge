import { WaMessageStatus } from '@app/shared-types';

// Coche(s) WhatsApp selon le statut d'un message sortant.
export function statusMark(status: WaMessageStatus | null | undefined): string {
  switch (status) {
    case WaMessageStatus.PENDING:
      return '🕓';
    case WaMessageStatus.SENT:
      return '✓';
    case WaMessageStatus.DELIVERED:
    case WaMessageStatus.READ:
    case WaMessageStatus.PLAYED:
      return '✓✓';
    case WaMessageStatus.ERROR:
      return '⚠';
    default:
      return '';
  }
}

// Lu (coches bleues) : lu ou vocal écouté.
export function isReadStatus(status: WaMessageStatus | null | undefined): boolean {
  return status === WaMessageStatus.READ || status === WaMessageStatus.PLAYED;
}

// Ordre des statuts sortants : un statut ne recule jamais (accusés dans le
// désordre). « error » est hors échelle.
const ORDER: WaMessageStatus[] = [
  WaMessageStatus.PENDING,
  WaMessageStatus.SENT,
  WaMessageStatus.DELIVERED,
  WaMessageStatus.READ,
  WaMessageStatus.PLAYED,
];
export function statusRank(status: WaMessageStatus | null | undefined): number {
  return status ? ORDER.indexOf(status) : -1;
}
