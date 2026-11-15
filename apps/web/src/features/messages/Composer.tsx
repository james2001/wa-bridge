import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { WaMessageStatus, WaMessageType } from '@app/shared-types';
import type { WaAccount, WaMessage } from '@app/shared-types';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { selectComposerAction, setComposerAction } from '../ui/uiSlice';
import { editMessage, sendText, setTyping } from '../../services/socket';
import { http } from '../../services/http';
import { upsertMessage } from './messagesApi';
import { upsertPersonMessage } from '../people/peopleApi';

const EmojiPanel = lazy(() => import('../../components/EmojiPanel'));

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
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const typingRef = useRef(false);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);

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
  const [actionError, setActionError] = useState<string | null>(null);
  const cancelAction = () => {
    if (editing) setText('');
    setActionError(null);
    dispatch(setComposerAction(null));
  };

  // Entrée en modification : le texte du message revient dans la saisie.
  useEffect(() => {
    if (!editing) return;
    setActionError(null);
    setText(editing.text ?? '');
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

  // Hauteur du champ ajustée au contenu (plafonnée en CSS par max-height).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

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
          setText('');
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
      const ack = await sendText({
        accountId: sender,
        chatJid,
        text: value,
        clientId,
        ...(quotedId ? { quotedId } : {}),
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
      <textarea
        ref={inputRef}
        className="composer__input"
        rows={1}
        placeholder="Écrivez un message"
        aria-label="Message"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
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
