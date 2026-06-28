# Protocole de test E2E — Pont WhatsApp auto-hébergé

> Pont testé : **https://app.localhost:8553** (compte lié = **« Laurent Ehrsam »**, via Baileys 7.x + NestJS + React).
> Côté « réel » pour envoyer/recevoir : **https://web.whatsapp.com** connecté en tant que **« Stéphane Rathgeber »** (client WhatsApp officiel).
> Scénario pivot : Stéphane écrit à Laurent → vérifier le rendu dans le pont ; et l'inverse.

Ce document est un protocole **exécutable** (cases à cocher), **priorisé** :
**P0** = critique (cœur du MVP, doit fonctionner) · **P1** = important · **P2** = nice‑to‑have / confort.

> ⚠️ Plusieurs comportements demandés ne sont **probablement pas implémentés** d'après la lecture
> du code. Ils sont présents ci‑dessous comme cas de test (pour confirmer le constat) **et**
> récapitulés dans la section [« Manques pressentis »](#manques-pressentis--à-confirmer).

---

## 0. Préparation du banc de test

### 0.1 Pré‑requis communs (à faire une fois)
- [ ] La pile tourne (`make up` puis `make ps` → tout est `healthy`/`running`).
- [ ] Onglet A : `https://web.whatsapp.com` connecté en **Stéphane Rathgeber**.
- [ ] Onglet B : `https://app.localhost:8553` connecté au pont (mot de passe `APP_PASSWORD`), QR déjà scanné, état **« lié »** (bandeau de connexion absent, liste de discussions chargée).
- [ ] Le téléphone de **Laurent** (compte du pont) est accessible pour vérifier le multi‑device quand nécessaire.
- [ ] Le contact **Stéphane ↔ Laurent** existe des deux côtés (au moins un échange préalable).

### 0.2 Outils de vérification serveur (chemins/commandes)
- **Logs backend** : `make logs-backend` (ou `docker compose logs -f backend`).
  - Repères utiles : `WhatsApp connecté`, `markRead: N lu(s) sur <jid>`, `Carte LID chargée`, erreurs `messages.upsert: …`.
- **Base de données** (Postgres, service `postgres`) :
  ```bash
  docker compose exec postgres psql -U whatapp -d whatapp
  ```
  Tables et colonnes clés :
  | Table | Colonnes utiles |
  | --- | --- |
  | `wa_messages` | `id`, `chat_jid`, `from_me`, `sender_jid`, `sender_name`, `type`, `text`, `sent_at`, `status`, `quoted_id`, `media` (JSON), `reactions` (JSON), `client_id`, `raw_message` (JSON), `file_sha256` |
  | `wa_chats` | `jid`, `name`, `is_group`, `unread_count`, `last_message_at`, `last_message_preview` |
  | `wa_lid_map` | `lid`, `pn` (correspondance identité masquée → numéro) |
- **Requêtes types** :
  ```sql
  -- Derniers messages d'une conversation (remplace le JID par le numéro de Stéphane)
  SELECT id, from_me, type, left(text,40) AS txt, status, quoted_id, sent_at
  FROM wa_messages WHERE chat_jid = '<num>@s.whatsapp.net'
  ORDER BY sent_at DESC LIMIT 10;

  -- État d'une discussion (non-lus, aperçu, ordre)
  SELECT jid, name, is_group, unread_count, last_message_preview, last_message_at
  FROM wa_chats ORDER BY last_message_at DESC LIMIT 20;

  -- Doublons média (même fichier, ids distincts dans le même chat)
  SELECT chat_jid, file_sha256, count(*) FROM wa_messages
  WHERE file_sha256 IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;
  ```
- **Réseau / temps réel (DevTools onglet B)** : Network → WS (socket.io). Observer les trames
  `wa:message`, `wa:message-status`, `wa:reaction`, `wa:chat-upsert`, `wa:chats`.
- **Endpoint média** : `GET /api/wa/media/:chatJid/:id` (auth Bearer ou `?t=<jwt>`).

### 0.3 Convention
Dans chaque cas : **Stéphane** = action sur `web.whatsapp.com` (onglet A). **Pont** = observation/action sur `app.localhost:8553` (onglet B). « Sans rafraîchir » = ne pas recharger l'onglet B.

---

## 1. Réception Stéphane → Pont

### Texte

#### RX‑01 · P0 · Texte simple
- **Préconditions** : conversation Stéphane↔Laurent ouverte dans le pont.
- **Étapes** : Stéphane envoie `Bonjour Laurent`.
- **Attendu** : une bulle entrante (alignée à gauche) `Bonjour Laurent` apparaît dans le pont, avec heure.
- **Vérif serveur** : `wa_messages` → 1 ligne `from_me=false`, `type='text'`, `text='Bonjour Laurent'`. Trame WS `wa:message`.

#### RX‑02 · P0 · Emoji + accents + caractères spéciaux
- **Étapes** : Stéphane envoie `Éàèùçœ — café 🥐☕️ 👍🏽 «test» 北京`.
- **Attendu** : texte rendu **à l'identique** (accents, emoji multi‑codepoint avec teinte de peau, guillemets, idéogrammes), sans `?`, mojibake ou emoji cassé.
- **Vérif serveur** : `text` en base contient exactement la même chaîne UTF‑8.

#### RX‑03 · P1 · Message long (multi‑lignes / wrapping)
- **Étapes** : Stéphane envoie un message de ~1500 caractères avec sauts de ligne.
- **Attendu** : bulle qui retourne à la ligne proprement, scroll vertical correct, pas de débordement hors bulle.

#### RX‑04 · P1 · Réponse citée (quote) reçue
- **Préconditions** : un message `M` de Laurent ou Stéphane existe déjà dans la conversation.
- **Étapes** : sur `web.whatsapp.com`, Stéphane **répond** (glisser pour répondre) à `M` avec `Je réponds à ceci`.
- **Attendu (idéal)** : la bulle entrante affiche `Je réponds à ceci` **et** un encart citant le message `M` (extrait + auteur).
- **Attendu (réel pressenti)** : ⚠️ le texte de la réponse arrive, **mais l'encart du message cité n'est PAS affiché** (voir [G‑01](#g-01)). Le test sert à confirmer ce manque.
- **Vérif serveur** : `wa_messages.quoted_id` de la nouvelle ligne = `id` du message `M` (la donnée est bien captée côté backend, seul l'affichage manque).

### Réactions

#### RX‑05 · P1 · Réaction emoji — ajout
- **Préconditions** : un message **de Laurent** (`from_me=true`) visible côté Stéphane.
- **Étapes** : Stéphane réagit `❤️` à ce message.
- **Attendu** : sous la bulle correspondante dans le pont, une puce `❤️` apparaît **sans rafraîchir**.
- **Vérif serveur** : `wa_messages.reactions` du message cible = `[{emoji:'❤️', …}]`. Trame WS `wa:reaction`. (Note : une réaction ne crée PAS de bulle distincte.)

#### RX‑06 · P1 · Réaction emoji — modification puis retrait
- **Étapes** : Stéphane change sa réaction en `😂`, puis la **retire**.
- **Attendu** : la puce passe à `😂`, puis **disparaît** après retrait.
- **Vérif serveur** : `reactions` passe à `[{emoji:'😂',…}]` puis `[]` (un emoji vide = retrait, filtré côté backend).

### Édition / suppression

#### RX‑07 · P2 · Édition d'un message reçu
- **Préconditions** : Stéphane a envoyé `Version 1` (visible dans le pont).
- **Étapes** : Stéphane **modifie** ce message en `Version 2 corrigée`.
- **Attendu (idéal)** : la bulle dans le pont passe à `Version 2 corrigée` (idéalement avec mention « modifié »).
- **Attendu (réel pressenti)** : ⚠️ **aucun changement** dans le pont, la bulle reste `Version 1` (voir [G‑02](#g-02)).
- **Vérif serveur** : `wa_messages.text` reste `Version 1` (l'édition arrive en `protocolMessage` filtré → ignorée).

#### RX‑08 · P1 · Suppression « pour tout le monde »
- **Préconditions** : Stéphane a envoyé `À supprimer` (visible dans le pont).
- **Étapes** : Stéphane fait **Supprimer → Supprimer pour tout le monde**.
- **Attendu (idéal)** : la bulle est remplacée par « Ce message a été supprimé » (ou retirée).
- **Attendu (réel pressenti)** : ⚠️ la bulle `À supprimer` **reste affichée** telle quelle dans le pont (voir [G‑03](#g-03)).
- **Vérif serveur** : aucun événement `wa:message-deleted` n'est émis ; la ligne `wa_messages` reste inchangée.

### Médias (Stéphane → Pont)

> Pré‑requis média : tester avec de **nouveaux** envois (le `raw_message` n'est conservé que depuis l'ajout du lecteur média ; les anciens médias ne sont pas (re)téléchargeables).

#### RX‑09 · P1 · Image (sans légende)
- **Étapes** : Stéphane envoie une photo JPEG.
- **Attendu** : miniature visible dans la bulle ; clic → ouverture **plein écran** (lightbox) ; pas de placeholder « 📷 Photo ».
- **Vérif serveur** : `type='image'`, `media.kind='image'`, `raw_message` non nul ; `GET /api/wa/media/<chat>/<id>` renvoie l'image (200, `Content-Type: image/*`).

#### RX‑10 · P1 · Image avec légende
- **Étapes** : Stéphane envoie une photo avec la légende `Voici la photo 📸`.
- **Attendu** : image affichée **+** légende `Voici la photo 📸` sous l'image.
- **Vérif serveur** : `media.caption` et/ou `text` = la légende.

#### RX‑11 · P1 · Vidéo
- **Étapes** : Stéphane envoie une vidéo MP4 (~10 s).
- **Attendu** : lecteur `<video controls>` jouable (play/pause/seek) ; double‑clic → plein écran. **Une seule bulle** (pas de doublon, cf. RB‑01).
- **Vérif serveur** : `type='video'`, durée/`width`/`height` renseignés ; un seul `file_sha256` pour ce chat.

#### RX‑12 · P1 · Note vocale (PTT)
- **Étapes** : Stéphane enregistre et envoie une **note vocale**.
- **Attendu** : lecteur audio avec libellé « 🎙️ Message vocal » + durée ; lecture/pause fonctionnelles.
- **Vérif serveur** : `type='audio'`, `media.ptt=true`, `durationSec` renseigné.

#### RX‑13 · P2 · Audio (fichier, non‑PTT)
- **Étapes** : Stéphane envoie un fichier `.mp3`/`.m4a` (pas un vocal).
- **Attendu** : lecteur audio avec libellé « 🎵 Audio ».
- **Vérif serveur** : `type='audio'`, `media.ptt=false`.

#### RX‑14 · P1 · Document (PDF)
- **Étapes** : Stéphane envoie un PDF nommé `facture.pdf`.
- **Attendu** : bloc document avec **nom** (`facture.pdf`) + **taille** + action « Télécharger » qui télécharge réellement le fichier.
- **Vérif serveur** : `type='document'`, `media.fileName='facture.pdf'` ; endpoint média renvoie `Content-Disposition: attachment; filename="facture.pdf"`.

#### RX‑15 · P1 · Sticker
- **Étapes** : Stéphane envoie un sticker.
- **Attendu** : image WebP affichée en **petit format** (pas de placeholder).
- **Vérif serveur** : `type='sticker'`.

#### RX‑16 · P2 · Type non géré (position / contact)
- **Étapes** : Stéphane partage une **position** puis une **carte de visite (contact)**.
- **Attendu** : bulle de repli lisible (`📍 Position` / `👤 Contact`) — pas de crash, pas de bulle vide.
- **Vérif serveur** : `type='location'` / `type='contact'`.

---

## 2. Envoi Pont → Stéphane

#### TX‑01 · P0 · Texte sortant + arrivée chez Stéphane
- **Étapes** : dans le pont, Laurent écrit `Réponse depuis le pont ✅` et envoie.
- **Attendu** :
  - Pont : bulle sortante (à droite) immédiate (optimistic 🕓) puis ✓ après ACK.
  - Stéphane (onglet A) : le message `Réponse depuis le pont ✅` **arrive** dans la conversation, **sans rafraîchir**.
- **Vérif serveur** : `wa_messages` → ligne `from_me=true`, `status` passe `pending→sent`. ACK `wa:send-text` `ok:true`.

#### TX‑02 · P1 · Texte sortant avec emoji/accents
- **Étapes** : Laurent envoie `Café à 14h ? 🙂 — œuf`.
- **Attendu** : reçu **intact** chez Stéphane (accents, emoji, tiret cadratin).

#### TX‑03 · P2 · Réponse citée envoyée depuis le pont
- **Étapes** : tenter de répondre (citer) à un message depuis le pont.
- **Attendu (réel pressenti)** : ⚠️ **aucune UI de citation** dans le composer ; même si l'événement `wa:send-text` accepte un `quotedId`, le backend l'**ignore** (voir [G‑04](#g-04)).

#### TX‑04 · P2 · Envoi de média depuis le pont
- **Étapes** : chercher un bouton « pièce jointe / image / fichier » dans le composer.
- **Attendu (réel pressenti)** : ⚠️ **non disponible** — le composer n'envoie que du texte ; aucun endpoint d'upload média n'existe (voir [G‑05](#g-05)).

---

## 3. Statuts (accusés)

#### ST‑01 · P0 · ✓ puis ✓✓ sur message sortant
- **Préconditions** : le téléphone de Stéphane est en ligne.
- **Étapes** : Laurent envoie un message depuis le pont ; observer la coche.
- **Attendu** : 🕓 (pending) → ✓ (sent) → ✓✓ (delivered) quand le téléphone de Stéphane le reçoit.
- **Vérif serveur** : `wa_messages.status` : `pending`→`sent`→`delivered`. Trames `wa:message-status`.

#### ST‑02 · P1 · ✓✓ **bleu** quand Stéphane lit (sens pont → Stéphane)
- **Étapes** : Stéphane **ouvre/lit** le message envoyé par Laurent.
- **Attendu** : dans le pont, la coche du message sortant devient **✓✓ bleu** (statut « lu »).
- **Vérif serveur** : `status='read'`. Reçu via `message-receipt.update` (`readTimestamp`).

#### ST‑03 · P1 · Lecture côté pont → ✓✓ bleu chez Stéphane (sens Stéphane → pont)
- **Préconditions** : Stéphane a envoyé un message **non lu** ; ce message reste non lu côté Stéphane (✓✓ gris chez lui).
- **Étapes** : dans le pont, **ouvrir** la conversation (déclenche `wa:mark-read`).
- **Attendu** : chez Stéphane (onglet A), la coche de **son** message passe à **✓✓ bleu**.
- **Vérif serveur** : log `markRead: N lu(s) sur <jid>` (la cible doit être le **LID** pour un DM, sinon l'accusé est ignoré). `readMessages` appelé.

#### ST‑04 · P2 · Note vocale écoutée (played)
- **Préconditions** : Laurent peut envoyer un vocal — ⚠️ **non supporté** (cf. TX‑04). À défaut, vérifier dans le sens inverse : Stéphane lit un vocal de Laurent (non envoyable depuis le pont).
- **Attendu** : statut `played` (✓✓ bleu) si applicable. **Probablement non testable** tant que l'envoi de média n'existe pas.

#### ST‑05 · P1 · Échec d'envoi
- **Étapes** : couper la connectivité WhatsApp (ex. téléphone de Laurent hors‑ligne / état pont ≠ « open ») puis tenter un envoi.
- **Attendu** : la bulle passe en **⚠ erreur** (`bubble--failed`) ; pas de crash UI.
- **Vérif serveur** : ACK `ok:false` (ex. `WhatsApp non connecté`).

---

## 4. Non‑lus (badges)

#### UN‑01 · P0 · Incrément à la réception
- **Préconditions** : la conversation Stéphane n'est **pas** ouverte/active dans le pont (sélectionner une autre conversation).
- **Étapes** : Stéphane envoie 2 messages.
- **Attendu** : un **badge** apparaît sur la conversation Stéphane dans la liste, avec un compteur > 0.
- **Vérif serveur** : `wa_chats.unread_count` > 0. ⚠️ Le compteur dépend de l'événement `chats.update` de WhatsApp (autoritaire) — `touchChat` n'incrémente pas lui‑même. Vérifier la **réactivité** (immédiate vs. différée) — voir [G‑06](#g-06).

#### UN‑02 · P0 · Remise à 0 en ouvrant côté pont
- **Étapes** : ouvrir la conversation Stéphane dans le pont.
- **Attendu** : le badge disparaît immédiatement.
- **Vérif serveur** : `wa_chats.unread_count=0` ; trame `wa:chat-upsert`.

#### UN‑03 · P1 · Remise à 0 quand lu sur le téléphone de Laurent
- **Préconditions** : badge > 0 dans le pont ; conversation non ouverte dans le pont.
- **Étapes** : lire la conversation sur le **téléphone de Laurent** (multi‑device).
- **Attendu** : le badge se remet à 0 dans le pont **sans rafraîchir** (reflet de l'état multi‑device).
- **Vérif serveur** : `chats.update` → `unread_count=0` ; `wa:chat-upsert`.

---

## 5. Temps réel

#### RT‑01 · P0 · Nouveau message sans rafraîchir
- **Préconditions** : conversation Stéphane **ouverte** dans le pont, vue scrollée en bas.
- **Étapes** : Stéphane envoie `Temps réel ?`.
- **Attendu** : la bulle apparaît **immédiatement** (≤ ~2 s) sans recharger ; auto‑scroll en bas.
- **Vérif** : trame WS `wa:message` dans DevTools (onglet B).

#### RT‑02 · P1 · Aperçu + remontée dans la liste sans rafraîchir
- **Préconditions** : une **autre** conversation est ouverte.
- **Étapes** : Stéphane envoie un message.
- **Attendu** : dans la liste, la conversation Stéphane **remonte en tête** et son aperçu (`last_message_preview`) se met à jour, sans rafraîchir.
- **Vérif serveur** : `wa_chats.last_message_at` mis à jour ; `wa:chat-upsert`.

#### RT‑03 · P1 · Bouton « ↓ Nouveaux messages » si pas en bas
- **Préconditions** : conversation ouverte, scrollée **vers le haut** (historique).
- **Étapes** : Stéphane envoie un message.
- **Attendu** : pas d'auto‑scroll ; un bouton « ↓ Nouveaux messages » apparaît ; clic → descend en bas.

---

## 6. Présence / « en train d'écrire »

#### PR‑01 · P2 · Indicateur « en train d'écrire » (Stéphane → pont)
- **Préconditions** : conversation Stéphane ouverte dans le pont.
- **Étapes** : Stéphane commence à taper (sans envoyer) dans `web.whatsapp.com`.
- **Attendu (idéal)** : l'en‑tête du pont affiche « en train d'écrire… ».
- **Attendu (réel pressenti)** : ⚠️ **rien ne s'affiche** — le backend ne s'abonne pas à `presence.update`, n'émet jamais `wa:presence`, et le handler `wa:subscribe-presence` n'existe pas côté gateway (voir [G‑07](#g-07)). L'UI sait l'afficher mais ne reçoit aucune donnée.
- **Vérif** : aucune trame `wa:presence` côté DevTools.

#### PR‑02 · P2 · Statut « en ligne » du contact
- **Étapes** : Stéphane ouvre l'app / est actif.
- **Attendu (réel pressenti)** : ⚠️ non affiché (même cause que PR‑01). L'en‑tête montre le numéro à la place du statut.

#### PR‑03 · P2 · « en train d'écrire » dans l'autre sens (pont → Stéphane)
- **Étapes** : Laurent tape dans le composer du pont.
- **Attendu** : le pont **émet** `composing` (`wa:typing` → `sendPresenceUpdate`). Stéphane **devrait** voir « en train d'écrire » sur son app. (Émission présente ; à confirmer côté Stéphane.)

---

## 7. Liste de discussions

#### CL‑01 · P0 · Tri par récence
- **Étapes** : provoquer un nouveau message dans une conversation ancienne.
- **Attendu** : elle **remonte en tête** de liste ; tri décroissant par dernier message.
- **Vérif serveur** : `ORDER BY last_message_at DESC` (backend) + tri client.

#### CL‑02 · P0 · Aperçu du dernier message
- **Attendu** : chaque conversation montre le dernier message (texte) ou un aperçu typé (`📷 Photo`, `🎬 Vidéo`, `🎙️ Message vocal`, `📎 <nom>`, `🩷 Sticker`, `📍 Position`, `👤 Contact`).
- **Vérif serveur** : `wa_chats.last_message_preview`.

#### CL‑03 · P0 · Nom du contact
- **Attendu** : la conversation Stéphane affiche un **nom** (`Stéphane Rathgeber` ou pushName) ; à défaut le **numéro lisible** (pas le JID brut `…@s.whatsapp.net`, pas un `…@lid`).
- **Vérif serveur** : `wa_chats.name` ; sinon repli `prettyJid`.

#### CL‑04 · P0 · Pas de `status@broadcast` ni newsletters
- **Étapes** : Stéphane publie un **statut/story** ; un canal/newsletter reçoit un message.
- **Attendu** : **aucune** entrée `status@broadcast` ni `@newsletter` n'apparaît dans la liste.
- **Vérif serveur** : `SELECT * FROM wa_chats WHERE jid='status@broadcast' OR jid LIKE '%@newsletter';` → 0 ligne.

---

## 8. Groupes

#### GR‑01 · P1 · Réception d'un message de groupe
- **Préconditions** : Laurent est membre d'un groupe où Stéphane (et d'autres) postent.
- **Étapes** : Stéphane envoie un message dans le groupe.
- **Attendu** : la conversation de groupe apparaît/remonte ; le message s'affiche.
- **Vérif serveur** : `wa_messages` avec `chat_jid` en `…@g.us`, `is_group=true`, `sender_jid` = participant (numéro résolu, pas un LID).

#### GR‑02 · P1 · Nom de l'expéditeur affiché dans le groupe
- **Étapes** : observer une bulle entrante de groupe (de Stéphane).
- **Attendu (idéal)** : au‑dessus de la bulle, le **nom de l'expéditeur** (`Stéphane Rathgeber`).
- **Attendu (réel pressenti)** : ⚠️ le nom **n'est pas affiché** — `sender_name` est stocké en base mais `MessageBubble` ne le rend pas (voir [G‑08](#g-08)). Difficile de distinguer les expéditeurs.
- **Vérif serveur** : `wa_messages.sender_name` est renseigné (donnée présente, affichage manquant).

#### GR‑03 · P2 · Messages système de groupe (ajout/retrait, sujet)
- **Étapes** : un admin ajoute/retire un membre, change le sujet.
- **Attendu** : soit un message système lisible, soit ignoré proprement (pas de bulle « non pris en charge » disgracieuse). À constater.

---

## 9. Robustesse

#### RB‑01 · P0 · Pas de doublon (1 message = 1 bulle)
- **Étapes** : Stéphane envoie **1** texte, puis **1** vidéo.
- **Attendu** : exactement **une** bulle par envoi (la double livraison LID + téléphone ne doit pas créer 2 bulles).
- **Vérif serveur** :
  - Texte : dédup par clé primaire `(chat_jid, id)`.
  - Média : `SELECT chat_jid,file_sha256,count(*) … HAVING count(*)>1;` → **0 ligne**.

#### RB‑02 · P0 · LID résolu → 1 contact = 1 conversation
- **Étapes** : recevoir plusieurs messages de Stéphane (certains adressés via `@lid`).
- **Attendu** : **une seule** conversation Stéphane (pas de doublon `@lid` + numéro). L'historique fusionne sous le numéro.
- **Vérif serveur** : `SELECT jid FROM wa_chats WHERE jid LIKE '%@lid';` → 0 ligne pour Stéphane ; `wa_lid_map` contient sa correspondance `lid → pn`.

#### RB‑03 · P1 · Scroll + pagination d'historique
- **Préconditions** : conversation avec > 50 messages.
- **Étapes** : ouvrir la conversation (scroll auto en bas) puis **remonter** vers le haut.
- **Attendu** : « Chargement de l'historique… » apparaît, les messages plus anciens se préfixent **sans saut de position** ; pas de doublon ; tri chronologique conservé.
- **Vérif serveur** : appels `GET /wa/chats/:jid/messages?before=…&limit=50` successifs ; `hasMore`/`nextBefore` cohérents.

#### RB‑04 · P1 · Réconciliation de l'écho optimistic
- **Étapes** : envoyer un texte depuis le pont (TX‑01) et observer la bulle.
- **Attendu** : la bulle « pending » est **remplacée** par la version serveur (pas deux bulles) — corrélation via `clientId`.
- **Vérif** : `upsertMessage` matche `id` **ou** `clientId`.

#### RB‑05 · P1 · Reconnexion socket / WhatsApp
- **Étapes** : recharger l'onglet B (Ctrl+Shift+R) ; couper/rétablir le réseau backend.
- **Attendu** : à la reconnexion, l'état (`wa:connection`) et la liste (`wa:chats`) sont re‑poussés ; les messages reçus pendant la coupure apparaissent après resync.

#### RB‑06 · P2 · Sécurité de l'endpoint média
- **Étapes** : appeler `GET /api/wa/media/<chat>/<id>` **sans** token (ni Bearer ni `?t=`).
- **Attendu** : accès refusé (401) ; avec un JWT valide → 200 + binaire. 2ᵉ appel servi depuis le cache disque (`media_cache`).

---

## Manques pressentis — à confirmer

> Déduits de la lecture du code. Chacun a un cas de test ci‑dessus pour le **confirmer**.
> Classés du plus impactant au moins impactant.

<a id="g-01"></a>
### G‑01 · P1 · Affichage des réponses citées (quote) — **probablement manquant**
Le backend **capte** le message cité (`wa_messages.quoted_id` rempli depuis `contextInfo.stanzaId`),
mais `MessageBubble.tsx` n'affiche **aucun encart** de citation et ne va pas chercher le message cité.
→ La réponse arrive comme un message normal, sans contexte. **Confirmer via RX‑04.**

<a id="g-02"></a>
### G‑02 · P2 · Édition d'un message entrant — **non géré**
`extractContent` retourne `null` pour `protocolMessage` (donc pour les éditions, qui transitent par là),
et `onMessagesUpdate` ne traite que le `status`. Une édition reçue est **silencieusement ignorée** ;
la bulle conserve l'ancien texte. **Confirmer via RX‑07.**

<a id="g-03"></a>
### G‑03 · P1 · Suppression « pour tout le monde » — **non répercutée**
La révocation arrive en `protocolMessage` (mappé à `null` → ignoré). Le backend **n'émet jamais**
`wa:message-deleted` (l'événement existe dans le contrat et le frontend sait le traiter, mais rien
ne le déclenche). → Le message supprimé **reste affiché** dans le pont. **Confirmer via RX‑08.**

<a id="g-07"></a>
### G‑04 · P2 · Présence / « en train d'écrire » entrante — **non implémentée**
Aucun abonnement à `presence.update` côté Baileys, aucune émission de `wa:presence`, et le handler
`wa:subscribe-presence` est **absent** de la gateway (le client l'émet pourtant). L'UI (`ChatHeader`)
sait afficher « en train d'écrire… »/« en ligne » mais **ne reçoit jamais de donnée**.
**Confirmer via PR‑01 / PR‑02.**

<a id="g-08"></a>
### G‑05 · P1 · Nom de l'expéditeur en groupe — **non affiché**
`sender_name` est bien persisté, mais `MessageBubble.tsx` ne le rend pas. Dans un groupe, impossible
de savoir **qui** a écrit chaque bulle. **Confirmer via GR‑02.**

<a id="g-05"></a>
### G‑06 · P1 · Envoi de média depuis le pont — **non supporté**
Seul `sendText` existe (service + gateway `wa:send-text`). Pas d'endpoint d'upload, pas de bouton
pièce jointe dans le `Composer`. → Impossible d'envoyer image/vidéo/vocal/document depuis le pont.
**Confirmer via TX‑04.**

<a id="g-04"></a>
### G‑07 · P2 · Envoi d'une réponse citée depuis le pont — **non implémenté**
L'événement `wa:send-text` accepte un `quotedId` optionnel dans le contrat, mais
`WhatsappService.sendText` **l'ignore** (signature `chatJid, text, clientId`) et le composer n'offre
aucune UI de citation. **Confirmer via TX‑03.**

<a id="g-06"></a>
### G‑08 · P2 · Réactivité du compteur de non‑lus — **à vérifier (dépendance externe)**
`touchChat` **n'incrémente pas** le compteur ; l'`unread_count` provient uniquement de l'événement
`chats.update` de WhatsApp (choix assumé pour éviter le double comptage LID). Le badge peut donc
**ne pas s'incrémenter immédiatement** à la réception. **Confirmer la latence via UN‑01.**

### Autres points à surveiller (mineurs)
- **Statut `played` (vocal écouté)** difficilement testable tant que l'envoi de vocal depuis le pont n'existe pas (ST‑04).
- **Messages système de groupe** (ajout/retrait/sujet) : rendu non spécifié (GR‑03).
- **Avatars** (`avatarUrl`) jamais peuplés → la liste et l'en‑tête affichent toujours les initiales.
- **Édition d'un message envoyé par le pont** : aucune UI (cohérent avec G‑02).

---

## Récapitulatif d'exécution

| Domaine | Cas | P0 | P1 | P2 |
| --- | --- | --- | --- | --- |
| 1. Réception | RX‑01…16 | 2 | 9 | 5 |
| 2. Envoi | TX‑01…04 | 1 | 1 | 2 |
| 3. Statuts | ST‑01…05 | 1 | 3 | 1 |
| 4. Non‑lus | UN‑01…03 | 2 | 1 | 0 |
| 5. Temps réel | RT‑01…03 | 1 | 2 | 0 |
| 6. Présence | PR‑01…03 | 0 | 0 | 3 |
| 7. Liste | CL‑01…04 | 4 | 0 | 0 |
| 8. Groupes | GR‑01…03 | 0 | 2 | 1 |
| 9. Robustesse | RB‑01…06 | 2 | 3 | 1 |
| **Total** | **47** | **13** | **21** | **13** |

> Recommandation d'ordre d'exécution : **P0** (CL, RX‑01/02, TX‑01, RT‑01, ST‑01, UN‑01/02, RB‑01/02) en premier
> pour valider le cœur, puis **P1**, puis **P2** (qui recoupent largement les manques pressentis).
</content>
</invoke>
