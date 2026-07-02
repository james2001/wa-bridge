-- Vue fusionnée par personne (Phase 3) — migration NON destructive.
-- Ajoute un index pour la timeline cross-compte d'une personne :
--   SELECT ... FROM wa_messages WHERE chat_jid = <pn> ORDER BY sent_at
-- L'index existant (account_id, chat_jid, sent_at) a account_id en tête et ne
-- peut donc pas servir cette requête (pas de filtre account_id).
CREATE INDEX "wa_messages_chat_jid_sent_at_idx" ON "wa_messages"("chat_jid","sent_at");
