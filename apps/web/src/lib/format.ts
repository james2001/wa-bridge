import { format, isToday, isYesterday } from 'date-fns';

// Heure locale courte (HH:mm) à partir d'un epoch ms.
export function formatTime(ts: number | null | undefined): string {
  if (ts == null) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return format(d, 'HH:mm');
}

// Horodatage compact pour la liste des discussions
// (aujourd'hui -> heure, hier -> "Hier", sinon date).
export function formatChatTime(ts: number | null | undefined): string {
  if (ts == null) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return 'Hier';
  return format(d, 'dd/MM/yyyy');
}

// Initiales pour un avatar de secours.
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
