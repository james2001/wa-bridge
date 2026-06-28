-- Édition de message: horodatage de la dernière édition (revoke + edit)

-- AlterTable
ALTER TABLE "wa_messages" ADD COLUMN "edited_at" TIMESTAMP(3);
