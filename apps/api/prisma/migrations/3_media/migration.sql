-- Médias: message brut (pour re-télécharger) + SHA-256 du fichier (dédup LID)

-- AlterTable
ALTER TABLE "wa_messages" ADD COLUMN "raw_message" JSONB;
ALTER TABLE "wa_messages" ADD COLUMN "file_sha256" TEXT;

-- CreateIndex
CREATE INDEX "wa_messages_chat_jid_file_sha256_idx" ON "wa_messages"("chat_jid", "file_sha256");
