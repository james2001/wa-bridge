-- Réactions emoji posées sur un message

-- AlterTable
ALTER TABLE "wa_messages" ADD COLUMN "reactions" JSONB;
