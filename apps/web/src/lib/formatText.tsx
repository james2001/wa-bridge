import type { ReactNode } from 'react';

// Mise en forme WhatsApp d'un texte, rendue en éléments React (jamais de HTML
// injecté) : *gras*, _italique_, ~barré~, `code`, ```bloc monospace``` et
// liens http(s) cliquables (nouvel onglet, sans referrer).

// Lien : s'arrête avant une ponctuation finale (« voir https://x.fr. »).
const URL_RE = String.raw`https?:\/\/[^\s<>"]+[^\s<>".,:;!?'")\]}]`;
// Marqueur * _ ~ collé au mot, non précédé/suivi d'une lettre ou d'un chiffre.
const MARK_RE = String.raw`(?<![\p{L}\p{N}])([*_~])(?=\S)([^\n]*?\S)\2(?![\p{L}\p{N}])`;
const CODE_RE = '`([^`\\n]+)`';
const INLINE = new RegExp(`(${URL_RE})|${MARK_RE}|${CODE_RE}`, 'gu');

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  INLINE.lastIndex = 0;
  // Copie locale : l'appel récursif ne doit pas partager lastIndex.
  const re = new RegExp(INLINE.source, INLINE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[1]) {
      out.push(
        <a key={key} href={m[1]} target="_blank" rel="noopener noreferrer">
          {m[1]}
        </a>,
      );
    } else if (m[2]) {
      const inner = renderInline(m[3], key);
      if (m[2] === '*') out.push(<strong key={key}>{inner}</strong>);
      else if (m[2] === '_') out.push(<em key={key}>{inner}</em>);
      else out.push(<s key={key}>{inner}</s>);
    } else if (m[4]) {
      out.push(
        <code key={key} className="fmt-code">
          {m[4]}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function formatWhatsappText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Blocs ```…``` d'abord : leur contenu n'est pas interprété.
  const parts = text.split(/```([\s\S]+?)```/g);
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      out.push(
        <code key={`b${idx}`} className="fmt-pre">
          {part}
        </code>,
      );
    } else if (part) {
      out.push(...renderInline(part, `t${idx}`));
    }
  });
  return out;
}
