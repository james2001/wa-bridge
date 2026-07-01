import { useEffect, useRef, useState } from 'react';
import { WaMessageStatus, WaMessageType } from '@app/shared-types';
import type { WaMessage } from '@app/shared-types';
import { useAppDispatch } from '../../app/hooks';
import { sendText, setTyping } from '../../services/socket';
import { http } from '../../services/http';
import { upsertMessage } from './messagesApi';

interface Props {
  chatJid: string;
  accountId: string;
}

export default function Composer({ chatJid, accountId }: Props) {
  const dispatch = useAppDispatch();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const typingRef = useRef(false);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stopTyping = () => {
    if (typingTimeout.current) {
      clearTimeout(typingTimeout.current);
      typingTimeout.current = null;
    }
    if (typingRef.current) {
      typingRef.current = false;
      setTyping(accountId, chatJid, false);
    }
  };

  // Arrête le 'composing' au changement de discussion / démontage.
  useEffect(() => () => stopTyping(), [chatJid]);

  const onChange = (value: string) => {
    setText(value);
    if (value.length > 0) {
      if (!typingRef.current) {
        typingRef.current = true;
        setTyping(accountId, chatJid, true);
      }
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(stopTyping, 2000);
    } else {
      stopTyping();
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;

    stopTyping();
    const clientId = crypto.randomUUID();
    const optimistic: WaMessage = {
      // L'écho optimistic appartient au compte actif (émetteur).
      accountId,
      id: clientId,
      chatJid,
      fromMe: true,
      senderJid: null,
      senderName: null,
      type: WaMessageType.TEXT,
      text: value,
      timestamp: Date.now(),
      status: WaMessageStatus.PENDING,
      quotedId: null,
      media: null,
      reactions: [],
      clientId,
    };

    setText('');
    setSending(true);
    dispatch(upsertMessage(accountId, chatJid, optimistic));

    try {
      const ack = await sendText({ accountId, chatJid, text: value, clientId });
      if (ack.ok && ack.message) {
        dispatch(upsertMessage(accountId, chatJid, ack.message));
      } else {
        dispatch(
          upsertMessage(accountId, chatJid, {
            ...optimistic,
            status: WaMessageStatus.ERROR,
          }),
        );
      }
    } catch {
      dispatch(
        upsertMessage(accountId, chatJid, {
          ...optimistic,
          status: WaMessageStatus.ERROR,
        }),
      );
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
        { params: { accountId } },
      );
    } catch {
      setUploadError(true);
    } finally {
      setUploading(false);
    }
  };

  return (
    <form className="composer" onSubmit={onSubmit}>
      <input
        ref={fileInputRef}
        type="file"
        hidden
        accept="image/*,video/*,audio/*,application/*"
        onChange={onFileSelected}
      />
      <button
        className="composer__attach"
        type="button"
        onClick={onPickFile}
        disabled={uploading}
        title="Joindre un fichier"
      >
        📎
      </button>
      <input
        className="composer__input"
        type="text"
        placeholder="Écrivez un message"
        value={text}
        onChange={(e) => onChange(e.target.value)}
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
  );
}
