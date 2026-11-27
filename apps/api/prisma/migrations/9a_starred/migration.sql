-- Messages importants (étoile), synchronisés avec WhatsApp (starAction)

-- AlterTable
ALTER TABLE "wa_messages" ADD COLUMN "starred" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "wa_messages_account_id_starred_sent_at_idx" ON "wa_messages"("account_id", "starred", "sent_at");
