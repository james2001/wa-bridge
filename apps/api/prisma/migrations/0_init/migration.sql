-- Cache WhatsApp

-- CreateTable
CREATE TABLE "wa_contacts" (
    "jid" TEXT NOT NULL,
    "name" TEXT,
    "push_name" TEXT,
    "is_group" BOOLEAN NOT NULL DEFAULT false,
    "avatar_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_contacts_pkey" PRIMARY KEY ("jid")
);

-- CreateTable
CREATE TABLE "wa_chats" (
    "jid" TEXT NOT NULL,
    "name" TEXT,
    "is_group" BOOLEAN NOT NULL DEFAULT false,
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMP(3),
    "last_message_preview" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "avatar_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_chats_pkey" PRIMARY KEY ("jid")
);

-- CreateIndex
CREATE INDEX "wa_chats_last_message_at_idx" ON "wa_chats"("last_message_at");

-- CreateTable
CREATE TABLE "wa_messages" (
    "id" TEXT NOT NULL,
    "chat_jid" TEXT NOT NULL,
    "from_me" BOOLEAN NOT NULL,
    "sender_jid" TEXT,
    "sender_name" TEXT,
    "type" TEXT NOT NULL DEFAULT 'text',
    "text" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "quoted_id" TEXT,
    "media" JSONB,
    "client_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wa_messages_pkey" PRIMARY KEY ("chat_jid","id")
);

-- CreateIndex
CREATE INDEX "wa_messages_chat_jid_sent_at_idx" ON "wa_messages"("chat_jid", "sent_at");
