import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { WaMessageStatus, WaMessageType } from '@app/shared-types';
import type { WaAccount, WaMessage } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { selectComposerAction, setComposerAction } from '../ui/uiSlice';
import { editMessage, sendText, setTyping } from '../../services/socket';
import { http } from '../../services/http';
import { upsertMessage } from './messagesApi';
import { upsertPersonMessage } from '../people/peopleApi';
import { draftKey, getDraft, setDraft } from '../../lib/drafts';
import { useGetGroupInfoQuery } from '../chats/chatsApi';

const EmojiPanel = lazy(() => import('../../components/EmojiPanel'));

// Échappe une chaîne pour l'insérer telle quelle dans une RegExp.
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Trombone (icône vectorielle : l'emoji 📎 varie trop selon les systèmes).
function PaperclipIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

interface Props {
  chatJid: string;
  accountId: string;
  // Vue fusionnée : comptes candidats pour l'envoi. Si fourni, on affiche un
  // sélecteur (quand > 1 compte) et on reflète l'écho dans la timeline fusionnée
  // (chatJid = JID pn de la personne). Absent = vue par compte (comportement historique).
  accountOptions?: WaAccount[];
}

export default function Composer({ chatJid, accountId, accountOptions }: Props) {
  const dispatch = useAppDispatch();
  const merged = accountOptions != null;
  // Compte émetteur : en fusionné, choisi par l'utilisateur (défaut = accountId,
  // càd le compte le plus récent de la personne).
  const [sender, setSender] = useState(accountId);
  // Brouillon par discussion : repris à l'ouverture, gardé à chaque frappe.
  const dKey = draftKey(merged ? 'merged' : accountId, chatJid);
  const [draftText, setDraftText] = useState(() => getDraft(dKey));
  // Texte d'un message en cours de modification : état séparé, pour que le
  // brouillon ne soit jamais écrasé (ni renvoyé) en passant d'édition à réponse.
  const [editText, setEditText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const typingRef = useRef(false);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiBtnRef = useRef<HTMLButtonElement | null>(null);

  // Réponse en cours (citation) pour CETTE discussion uniquement.
  const action = useAppSelector(selectComposerAction);
  const replyTo =
    action?.kind === 'reply' && action.chatJid === chatJid
      ? action.message
      : null;
  // Modification en cours d'un de ses messages (CETTE discussion).
  const editing =
    action?.kind === 'edit' && action.chatJid === chatJid
      ? action.message
      : null;
  // Saisie affichée : le message modifié, sinon le brouillon. Quitter
  // l'édition (annuler, valider, ou passer à une réponse) ramène le brouillon.
  const text = editing ? editText : draftText;
  const setText = editing ? setEditText : setDraftText;
  const [actionError, setActionError] = useState<string | null>(null);
  const cancelAction = () => {
    setActionError(null);
    dispatch(setComposerAction(null));
  };

  // Entrée en modification : le texte du message revient dans la saisie.
  useEffect(() => {
    if (!editing) return;
    setActionError(null);
    setEditText(editing.text ?? '');
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [editing]);

  // Répondre : le curseur va dans la saisie ; en vue fusionnée, la réponse
  // part du compte qui a reçu le message cité (sinon citation introuvable).
  useEffect(() => {
    if (!replyTo) return;
    if (merged && replyTo.accountId !== sender) setSender(replyTo.accountId);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyTo]);

  // Insère l'emoji à la position du curseur (ou remplace la sélection). Ne
  // fait qu'éditer le champ : l'envoi reste sur Entrée / bouton ➤.
  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    onChange(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // Ouvrir une discussion place le curseur dans la saisie, comme WhatsApp Web.
  // Pas sur écran tactile : le clavier virtuel masquerait la conversation.
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) {
      inputRef.current?.focus();
    }
  }, [chatJid]);

  const stopTyping = () => {
    if (typingTimeout.current) {
      clearTimeout(typingTimeout.current);
      typingTimeout.current = null;
    }
    if (typingRef.current) {
      typingRef.current = false;
      setTyping(sender, chatJid, false);
    }
  };

  // Arrête le 'composing' au changement de discussion / démontage.
  useEffect(() => () => stopTyping(), [chatJid]);

  // Reflète un message (optimistic/ack/erreur) dans les caches: par-compte, et
  // aussi la timeline fusionnée quand on est en mode fusionné.
  const mirror = (msg: WaMessage) => {
    dispatch(upsertMessage(msg.accountId, chatJid, msg));
    if (merged) dispatch(upsertPersonMessage(msg));
  };

  // Brouillon gardé à chaque frappe (le texte d'une modification n'en est pas un).
  useEffect(() => {
    setDraft(dKey, draftText);
  }, [draftText, dKey]);

  // Hauteur du champ ajustée au contenu (plafonnée en CSS par max-height).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // --- Mentions @ (groupes) ---
  // Libellé affiché « @Nom » -> JID mentionné ; converti en « @numéro » +
  // liste mentions à l'envoi (format WhatsApp).
  const isGroupChat = chatJid.endsWith('@g.us');
  const mentionsRef = useRef(new Map<string, string>());
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const { data: groupInfo } = useGetGroupInfoQuery(
    { accountId: sender, jid: chatJid },
    { skip: !isGroupChat || mentionQuery === null },
  );
  const mentionCandidates =
    mentionQuery === null || !groupInfo
      ? []
      : groupInfo.participants
          .filter((p) => !p.isMe)
          .filter((p) => {
            const q = mentionQuery.toLowerCase();
            return (
              !q ||
              (p.name ?? '').toLowerCase().includes(q) ||
              p.jid.split('@')[0].includes(q)
            );
          })
          .slice(0, 8);

  const detectMention = (value: string) => {
    if (!isGroupChat || editing) return setMentionQuery(null);
    const caret = inputRef.current?.selectionStart ?? value.length;
    const m = /(^|\s)@([^\s@]{0,30})$/u.exec(value.slice(0, caret));
    setMentionQuery(m ? m[2] : null);
    setMentionIndex(0);
  };

  const pickMention = (p: { jid: string; name: string | null }) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const m = /@([^\s@]{0,30})$/u.exec(before);
    if (!m) return;
    const label = (p.name ?? p.jid.split('@')[0]).replace(/\s+/g, ' ').trim();
    mentionsRef.current.set(label, p.jid);
    const insert = `@${label} `;
    const next = before.slice(0, m.index) + insert + text.slice(caret);
    setText(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = m.index + insert.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // Texte réellement envoyé : « @Nom » -> « @numéro », + JIDs mentionnés.
  // Libellés les plus longs d'abord (« @Marc Dupont » avant « @Marc ») et
  // jamais au milieu d'un mot (« @Marc » ne touche pas « @Marcel »).
  const withMentions = (value: string): { text: string; mentions: string[] } => {
    let out = value;
    const mentions: string[] = [];
    const entries = [...mentionsRef.current].sort(
      (a, b) => b[0].length - a[0].length,
    );
    for (const [label, jid] of entries) {
      const re = new RegExp(`@${escapeRegExp(label)}(?![\\p{L}\\p{N}_])`, 'gu');
      const next = out.replace(re, `@${jid.split('@')[0]}`);
      if (next === out) continue;
      out = next;
      mentions.push(jid);
    }
    return { text: out, mentions };
  };

  const onChange = (value: string) => {
    setText(value);
    if (value.length > 0) {
      if (!typingRef.current) {
        typingRef.current = true;
        setTyping(sender, chatJid, true);
      }
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(stopTyping, 2000);
    } else {
      stopTyping();
    }
  };

  // Changement de compte émetteur (fusionné) : on arrête d'abord le 'composing'
  // sur l'ancien compte pour ne pas le laisser suspendu.
  const onChangeSender = (id: string) => {
    stopTyping();
    setSender(id);
  };

  const onSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    // Un envoi à la fois : jamais de double envoi pendant l'attente de l'ack.
    if (sending) return;
    const value = text.trim();
    if (!value) return;

    // Mode modification : on remplace le texte d'un message existant, on
    // n'envoie PAS de nouveau message.
    if (editing) {
      stopTyping();
      setSending(true);
      setActionError(null);
      try {
        const ack = await editMessage(
          editing.accountId,
          editing.chatJid,
          editing.id,
          value,
        );
        if (ack.ok) {
          dispatch(setComposerAction(null));
        } else {
          setActionError(ack.error ?? 'Échec de la modification');
        }
      } catch {
        setActionError('WhatsApp injoignable, modification non faite');
      } finally {
        setSending(false);
      }
      return;
    }

    stopTyping();
    const clientId = crypto.randomUUID();
    const quotedId = replyTo?.id ?? null;
    const optimistic: WaMessage = {
      // L'écho optimistic appartient au compte émetteur choisi.
      accountId: sender,
      id: clientId,
      chatJid,
      fromMe: true,
      senderJid: null,
      senderName: null,
      type: WaMessageType.TEXT,
      text: value,
      timestamp: Date.now(),
      status: WaMessageStatus.PENDING,
      quotedId,
      media: null,
      reactions: [],
      clientId,
    };

    setText('');
    if (quotedId) cancelAction();
    setSending(true);
    mirror(optimistic);

    try {
      const out = withMentions(value);
      mentionsRef.current.clear();
      const ack = await sendText({
        accountId: sender,
        chatJid,
        text: out.text,
        clientId,
        ...(quotedId ? { quotedId } : {}),
        ...(out.mentions.length ? { mentions: out.mentions } : {}),
      });
      if (ack.ok && ack.message) {
        mirror(ack.message);
      } else {
        mirror({ ...optimistic, status: WaMessageStatus.ERROR });
      }
    } catch {
      mirror({ ...optimistic, status: WaMessageStatus.ERROR });
    } finally {
      setSending(false);
    }
  };

  const onPickFile = () => {
    fileInputRef.current?.click();
  };

  // Envoi d'un média via REST multipart. Le backend émet ensuite 'wa:message'
  // (le média apparaît seul via le socket), donc pas d'insertion optimistic.
  const onFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Réinitialise tout de suite pour autoriser le renvoi du même fichier.
    e.target.value = '';
    if (!file) return;

    stopTyping();
    setUploadError(false);

    const caption = text.trim();
    const form = new FormData();
    form.append('file', file);
    if (caption.length > 0) form.append('caption', caption);

    // Vide le champ texte (utilisé comme légende).
    if (caption.length > 0) setText('');
    setUploading(true);

    try {
      // Pas de Content-Type manuel: axios pose le boundary multipart à partir
      // du FormData, et l'intercepteur http ajoute le Bearer.
      await http.post(
        `/wa/chats/${encodeURIComponent(chatJid)}/media`,
        form,
        { params: { accountId: sender } },
      );
    } catch {
      setUploadError(true);
    } finally {
      setUploading(false);
    }
  };

  const editLabel = editing ? (editing.text ?? '') : '';
  const replyLabel = replyTo
    ? replyTo.fromMe
      ? 'Vous'
      : (replyTo.senderName ?? 'Contact')
    : '';
  const replyText = replyTo
    ? (replyTo.text ?? (replyTo.media ? 'Média' : 'Message'))
    : '';

  return (
    <div className="composer-wrap">
      {editing && (
        <div className="composer__reply composer__reply--edit" role="status">
          <div className="composer__reply-body">
            <span className="composer__reply-who">Modifier le message</span>
            <span className="composer__reply-text">{editLabel}</span>
            {actionError && (
              <span className="composer__reply-error">{actionError}</span>
            )}
          </div>
          <button
            type="button"
            className="iconbtn composer__reply-cancel"
            title="Annuler la modification"
            aria-label="Annuler la modification"
            onClick={cancelAction}
          >
            ✕
          </button>
        </div>
      )}
      {replyTo && (
        <div className="composer__reply" role="status">
          <div className="composer__reply-body">
            <span className="composer__reply-who">Réponse à {replyLabel}</span>
            <span className="composer__reply-text">{replyText}</span>
          </div>
          <button
            type="button"
            className="iconbtn composer__reply-cancel"
            title="Annuler la réponse"
            aria-label="Annuler la réponse"
            onClick={cancelAction}
          >
            ✕
          </button>
        </div>
      )}
    <form className="composer" onSubmit={onSubmit}>
      {/* Sélecteur de compte émetteur (vue fusionnée, > 1 compte). */}
      {accountOptions && accountOptions.length > 1 && (
        <select
          className="composer__acct"
          value={sender}
          onChange={(e) => onChangeSender(e.target.value)}
          disabled={sending || uploading}
          title="Envoyer depuis le compte"
          aria-label="Compte émetteur"
        >
          {accountOptions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      )}
      <input
        ref={fileInputRef}
        type="file"
        hidden
        accept="image/*,video/*,audio/*,application/*"
        onChange={onFileSelected}
      />
      <div className="composer__emoji">
        <button
          ref={emojiBtnRef}
          className="composer__attach"
          type="button"
          onClick={() => setEmojiOpen((v) => !v)}
          title="Emojis"
          aria-label="Insérer un emoji"
          aria-expanded={emojiOpen}
        >
          ☺
        </button>
        {emojiOpen && (
          <Suspense fallback={null}>
            <EmojiPanel
              className="emojipanel--composer"
              triggerRef={emojiBtnRef}
              onPick={insertEmoji}
              onClose={() => setEmojiOpen(false)}
            />
          </Suspense>
        )}
      </div>
      <button
        className="composer__attach"
        type="button"
        onClick={onPickFile}
        disabled={uploading || Boolean(editing)}
        title="Joindre un fichier"
        aria-label="Joindre un fichier"
      >
        <PaperclipIcon />
      </button>
      {mentionQuery !== null && mentionCandidates.length > 0 && (
        <ul className="mentions" role="listbox" aria-label="Mentionner">
          {mentionCandidates.map((p, i) => (
            <li key={p.jid}>
              <button
                type="button"
                role="option"
                aria-selected={i === mentionIndex}
                className={'mentions__item' + (i === mentionIndex ? ' mentions__item--on' : '')}
                onMouseDown={(e) => {
                  // mousedown : garder le focus dans la saisie.
                  e.preventDefault();
                  pickMention(p);
                }}
              >
                <span className="mentions__name">{p.name ?? p.jid.split('@')[0]}</span>
                <span className="mentions__num">{p.jid.split('@')[0]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={inputRef}
        className="composer__input"
        rows={1}
        placeholder="Écrivez un message"
        aria-label="Message"
        value={text}
        onChange={(e) => {
          onChange(e.target.value);
          detectMention(e.target.value);
        }}
        onKeyDown={(e) => {
          // Liste de mentions ouverte : flèches, Entrée/Tab = choisir (jamais
          // envoyer), Échap = fermer.
          if (mentionQuery !== null && mentionCandidates.length > 0) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const n = mentionCandidates.length;
              setMentionIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              pickMention(mentionCandidates[Math.min(mentionIndex, mentionCandidates.length - 1)]);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setMentionQuery(null);
              return;
            }
          }
          if (e.key === 'Escape' && (replyTo || editing)) {
            cancelAction();
            return;
          }
          // Entrée envoie, Maj+Entrée va à la ligne (comme WhatsApp Web).
          // Ignoré pendant une composition IME et sur répétition de touche
          // (Entrée maintenue) : une frappe = au plus un envoi.
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) {
            return;
          }
          e.preventDefault();
          if (e.repeat) return;
          void onSubmit();
        }}
      />
      {uploading && <span className="composer__uploading">Envoi…</span>}
      {uploadError && (
        <span className="composer__uploading composer__uploading--error">
          Échec de l'envoi
        </span>
      )}
      <button
        className="composer__send"
        type="submit"
        disabled={sending || text.trim().length === 0}
        title="Envoyer"
      >
        ➤
      </button>
    </form>
    </div>
  );
}
