# Plan de test — Médias & doublons

Objectif : (A) diagnostiquer/corriger le **doublon de vidéo** et (B) valider le
**lecteur média** (affichage réel des images/vidéos/notes vocales/documents).

Accès : https://app.localhost:8553 — recharger (Ctrl+Shift+R) après chaque déploiement.

---

## A. Doublon de média (LID)

**Constat** : Stéphane a envoyé 1 vidéo → 2 entrées en base, **ids différents**
(`ACE057…`, `AC06CF…`), ~6 s d'écart, même contenu (1280×720, 10 s, 3,79 Mo).
Hypothèse : double livraison LID + téléphone avec des ids distincts → la dédup par
`(chatJid, id)` ne les fusionne pas.

### A1. Reproduire + diagnostiquer
1. Depuis un autre téléphone (Stéphane), envoyer **UNE** vidéo à ton compte.
2. Côté serveur, capturer les `messages.upsert` bruts (log de debug temporaire) :
   - noter les `key.id`, `key.remoteJid` (lid vs téléphone), `messageTimestamp`,
     et le `fileSha256` du `videoMessage` des deux copies.
3. **Critère de diagnostic** : si les deux copies ont le **même `fileSha256`** →
   c'est bien le même média (doublon) → dédup par hash de contenu justifiée.

### A2. Correction attendue
- Stocker `fileSha256` (hash du contenu) par message média.
- À l'insertion d'un message média, si un message du **même chat** a déjà le même
  `fileSha256` (fenêtre de quelques minutes), **ignorer** la nouvelle copie.
- **Critère d'acceptation** : envoyer 1 vidéo → **1 seule** bulle apparaît.

---

## B. Lecteur média

Pré-requis backend : le message brut (`message.*Message` proto) doit être stocké
pour permettre le téléchargement/déchiffrement via Baileys `downloadMediaMessage`
(les médias déjà en cache **avant** ce changement ne seront pas téléchargeables —
tester avec de **nouveaux** envois/réceptions).

### B1. Image (entrante & sortante)
- Recevoir une image (avec et sans légende) → miniature visible, clic → plein écran.
- Envoyer une image → s'affiche dans le fil.
- **Critère** : l'image s'affiche réellement (pas le placeholder « 📷 Photo »).

### B2. Vidéo
- Recevoir/envoyer une vidéo → lecteur `<video controls>` jouable (play/pause/seek).
- **Critère** : la vidéo se lit dans la bulle (ou en plein écran au clic).

### B3. Note vocale (ptt) & audio
- Recevoir une note vocale → lecteur audio avec durée, lecture/pause.
- **Critère** : la note vocale se joue ; statut « écouté » (✓✓ bleu → played) optionnel.

### B4. Document
- Recevoir un PDF/fichier → nom + taille + bouton télécharger qui fonctionne.

### B5. Sticker
- Recevoir un sticker → image (webp) affichée, taille réduite.

### B6. Cas limites
- **Média ancien/expiré** : Baileys doit re-demander (reupload) ; sinon message clair.
- **Gros fichier** : téléchargement en flux (stream), pas de blocage mémoire.
- **Cache** : 2e ouverture du même média → servi depuis le cache (pas de re-téléchargement).
- **Sécurité** : l'endpoint média est protégé par JWT (pas d'accès anonyme).

---

## Critères d'acceptation globaux
- [ ] 1 vidéo envoyée = 1 bulle (doublon corrigé).
- [ ] Images, vidéos, notes vocales, documents, stickers s'affichent/se lisent réellement.
- [ ] Endpoint média protégé (JWT) + mis en cache.
- [ ] Pas de régression : texte, statut ✓✓, réactions, liste/scroll, non-lus.
