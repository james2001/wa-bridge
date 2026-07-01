-- Multi-compte : introduction d'un account_id ('default' = données existantes).

-- 1) Table des comptes + compte par défaut (créé AVANT toute référence).
CREATE TABLE "wa_accounts" (
    "id"          TEXT NOT NULL,
    "label"       TEXT NOT NULL,
    "color"       TEXT,
    "phone_jid"   TEXT,
    "status"      TEXT NOT NULL DEFAULT 'disconnected',
    "is_default"  BOOLEAN NOT NULL DEFAULT false,
    "sort_order"  INTEGER NOT NULL DEFAULT 0,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wa_accounts_pkey" PRIMARY KEY ("id")
);
INSERT INTO "wa_accounts" ("id","label","is_default","sort_order","created_at")
VALUES ('default','Compte principal',true,0,CURRENT_TIMESTAMP);

-- 2) wa_contacts
ALTER TABLE "wa_contacts" ADD COLUMN "account_id" TEXT NOT NULL DEFAULT 'default';
UPDATE "wa_contacts" SET "account_id" = 'default';
ALTER TABLE "wa_contacts" DROP CONSTRAINT "wa_contacts_pkey";
ALTER TABLE "wa_contacts" ADD CONSTRAINT "wa_contacts_pkey" PRIMARY KEY ("account_id","jid");

-- 3) wa_chats
ALTER TABLE "wa_chats" ADD COLUMN "account_id" TEXT NOT NULL DEFAULT 'default';
UPDATE "wa_chats" SET "account_id" = 'default';
ALTER TABLE "wa_chats" DROP CONSTRAINT "wa_chats_pkey";
ALTER TABLE "wa_chats" ADD CONSTRAINT "wa_chats_pkey" PRIMARY KEY ("account_id","jid");
DROP INDEX "wa_chats_last_message_at_idx";
CREATE INDEX "wa_chats_account_id_last_message_at_idx" ON "wa_chats"("account_id","last_message_at");

-- 4) wa_messages
ALTER TABLE "wa_messages" ADD COLUMN "account_id" TEXT NOT NULL DEFAULT 'default';
UPDATE "wa_messages" SET "account_id" = 'default';
ALTER TABLE "wa_messages" DROP CONSTRAINT "wa_messages_pkey";
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_pkey" PRIMARY KEY ("account_id","chat_jid","id");
DROP INDEX "wa_messages_chat_jid_sent_at_idx";
CREATE INDEX "wa_messages_account_id_chat_jid_sent_at_idx" ON "wa_messages"("account_id","chat_jid","sent_at");
DROP INDEX "wa_messages_chat_jid_file_sha256_idx";
CREATE INDEX "wa_messages_account_id_chat_jid_file_sha256_idx" ON "wa_messages"("account_id","chat_jid","file_sha256");

-- 5) wa_lid_map
ALTER TABLE "wa_lid_map" ADD COLUMN "account_id" TEXT NOT NULL DEFAULT 'default';
UPDATE "wa_lid_map" SET "account_id" = 'default';
ALTER TABLE "wa_lid_map" DROP CONSTRAINT "wa_lid_map_pkey";
ALTER TABLE "wa_lid_map" ADD CONSTRAINT "wa_lid_map_pkey" PRIMARY KEY ("account_id","lid");
DROP INDEX "wa_lid_map_pn_idx";
CREATE INDEX "wa_lid_map_account_id_pn_idx" ON "wa_lid_map"("account_id","pn");
