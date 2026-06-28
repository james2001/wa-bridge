import { useEffect, useRef, useState } from 'react';
import { WaMessageStatus, WaMessageType } from '@app/shared-types';
import type { WaMessage } from '@app/shared-types';
import { useAppDispatch } from '../../app/hooks';
import { sendText, setTyping } from '../../services/socket';
import { upsertMessage } from './messagesApi';

interface Props {
  chatJid: string;
}

export default function Composer({ chatJid }: Props) {
  const dispatch = useAppDispatch();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const typingRef = useRef(false);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopTyping = () => {
    if (typingTimeout.current) {
      clearTimeout(typingTimeout.current);
      typingTimeout.current = null;
    }
    if (typingRef.current) {
      typingRef.current = false;
      setTyping(chatJid, false);
    }
  };

  // Arrête le 'composing' au changement de discussion / démontage.
  useEffect(() => () => stopTyping(), [chatJid]);

  const onChange = (value: string) => {
    setText(value);
    if (value.length > 0) {
      if (!typingRef.current) {
        typingRef.current = true;
        setTyping(chatJid, true);
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
    dispatch(upsertMessage(chatJid, optimistic));

    try {
      const ack = await sendText({ chatJid, text: value, clientId });
      if (ack.ok && ack.message) {
        dispatch(upsertMessage(chatJid, ack.message));
      } else {
        dispatch(
          upsertMessage(chatJid, {
            ...optimistic,
            status: WaMessageStatus.ERROR,
          }),
        );
      }
    } catch {
      dispatch(
        upsertMessage(chatJid, {
          ...optimistic,
          status: WaMessageStatus.ERROR,
        }),
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="composer" onSubmit={onSubmit}>
      <input
        className="composer__input"
        type="text"
        placeholder="Écrivez un message"
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
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
