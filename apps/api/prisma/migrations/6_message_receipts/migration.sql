-- Accusés de réception par destinataire (panneau « Infos du message »)

-- AlterTable
ALTER TABLE "wa_messages" ADD COLUMN "receipts" JSONB;
