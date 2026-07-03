-- Communautés WhatsApp (regroupement de groupes) — migration NON destructive.

-- 1) wa_chats : rattachement d'un groupe à sa communauté + drapeau "annonces".
ALTER TABLE "wa_chats" ADD COLUMN "community_jid" TEXT;
ALTER TABLE "wa_chats" ADD COLUMN "is_announce" BOOLEAN NOT NULL DEFAULT false;

-- 2) Métadonnées des communautés (nom, icône).
CREATE TABLE "wa_communities" (
    "account_id" TEXT NOT NULL DEFAULT 'default',
    "jid"        TEXT NOT NULL,
    "name"       TEXT,
    "avatar_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wa_communities_pkey" PRIMARY KEY ("account_id","jid")
);
