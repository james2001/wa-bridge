-- Correspondance LID -> numéro (@s.whatsapp.net)

-- CreateTable
CREATE TABLE "wa_lid_map" (
    "lid" TEXT NOT NULL,
    "pn" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wa_lid_map_pkey" PRIMARY KEY ("lid")
);

-- CreateIndex
CREATE INDEX "wa_lid_map_pn_idx" ON "wa_lid_map"("pn");
