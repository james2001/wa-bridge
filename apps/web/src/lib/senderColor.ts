// Couleur stable par membre d'un groupe (nom au-dessus de ses messages et
// citations), pour distinguer qui parle. Toujours la même pour un même jid ;
// teintes définies en clair et en sombre dans global.css (--sender-0..11).
const COUNT = 12;

export function senderColor(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return `var(--sender-${Math.abs(h) % COUNT})`;
}
