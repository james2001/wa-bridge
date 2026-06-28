# whatapp-clone — WhatsApp Web auto-hébergé

Un client web **branché sur ton vrai compte WhatsApp** (comme `web.whatsapp.com`),
auto-hébergé et dockerisé. Tu lies ton téléphone par **QR code** et tu accèdes à tes
discussions depuis le web, où que tu sois.

> **Statut : MVP du pont** — login par mot de passe, liaison QR, liste des discussions,
> historique, envoi/réception de messages texte en temps réel. Médias, accusés, présence
> et groupes arrivent ensuite (voir roadmap).

---

## ⚠️ À lire avant

- **Librairie non-officielle (Baileys).** Se connecter à un compte WhatsApp personnel via
  un client tiers est **contraire aux CGU de WhatsApp** et peut entraîner un **blocage du
  compte**. Tu assumes ce risque.
- **Pas d'appels.** Les appels audio/vidéo et le partage d'écran de WhatsApp utilisent un
  protocole propriétaire **inaccessible** à un client tiers. Ce pont fait la **messagerie**.
  Pour les appels, utilise l'app WhatsApp officielle.
- **La session WhatsApp est sensible.** L'état d'authentification (volume `wa_auth`)
  contient les identifiants de ta session liée. Protège ce volume.

## Stack

| Couche | Choix |
| --- | --- |
| Pont WhatsApp | **Baileys** 6.7 (protocole multi-device, WebSocket) |
| Backend | NestJS 10 + TypeScript, REST + Socket.io |
| Cache | PostgreSQL 16 + Prisma (chats/messages/contacts) |
| Frontend | React 18 + Vite (PWA), UI façon WhatsApp Web |
| Accès app | Mot de passe (`APP_PASSWORD`) → JWT |
| Reverse proxy / TLS | Caddy 2 |
| Orchestration | Docker Compose (monorepo pnpm) |

## Architecture

```
   navigateur ──HTTPS/WSS──▶ Caddy ──▶ /api, /socket.io ──▶ backend (NestJS)
                                   └──▶ /            ──▶ frontend (SPA)

   backend ──WebSocket (Baileys)──▶ serveurs WhatsApp   (ton compte, appareil lié)
   backend ──▶ PostgreSQL (cache chats/messages)
   backend ──▶ volume wa_auth (session WhatsApp persistée)
```

Le backend agit comme un **appareil lié** : il maintient la connexion WhatsApp, expose le
**QR** à scanner, relaie les messages en temps réel vers le web (Socket.io) et met en cache
les discussions dans Postgres.

## Démarrage

Prérequis : Docker + Docker Compose, Make.

```bash
make up             # crée .env, build, démarre la pile
make logs-backend   # suit les logs du backend
```

Puis ouvre **https://app.localhost** :
1. **Connexion** avec le mot de passe `APP_PASSWORD` (défini dans `.env`).
2. **Scan du QR** : sur ton téléphone, WhatsApp → *Appareils connectés* → *Lier un
   appareil* → scanne le code affiché.
3. Tes discussions se chargent. Envoie/reçois des messages texte en temps réel.

> Certificat de dev auto-signé : clique « Avancé → Continuer », ou `make trust-ca`.

> **Ports occupés ?** Si 80/443 sont pris (autre reverse proxy), définis `HTTP_PORT` /
> `HTTPS_PORT` (ex: 8444/8553) + `CORS_ORIGINS=https://app.localhost:8553` dans `.env`,
> et accède via `https://app.localhost:8553`.

## Commandes Make

| Commande | Description |
| --- | --- |
| `make up` | Build + démarre la pile |
| `make dev` | Mode développement (hot reload back + front) |
| `make logs-backend` | Logs backend |
| `make down` | Arrête la pile |
| `make clean` | Arrête **et efface** les volumes (cache + **session WhatsApp**) |
| `make trust-ca` | Installe la CA locale de Caddy (HTTPS de confiance) |

> `make clean` supprime le volume `wa_auth` → tu devras **re-scanner le QR**.

## Configuration (`.env`)

Régénère les secrets en production : `openssl rand -hex 32` pour `JWT_*`. Choisis un
`APP_PASSWORD` fort (c'est la seule barrière d'accès à tes discussions).

## Roadmap

- **MVP** ✅ Login mot de passe, liaison QR, liste discussions, historique, texte temps réel
- **P1** Médias : réception/envoi images, vidéos, **notes vocales**, documents, stickers
- **P2** Accusés (✓✓ bleus), présence (« en ligne », « en train d'écrire »), marquage lu
- **P3** Groupes : participants, noms/avatars, messages système
- **P4** Réactions, réponses (citations), suppressions, édition
- **P5** Recherche, épinglage, archivage, pagination d'historique infinie
- **P6** PWA installable + notifications (Web Push) des nouveaux messages
- **P7** Durcissement prod : Let's Encrypt, sauvegardes (cache + session), chiffrement au
  repos du volume `wa_auth`, multi-comptes éventuel

## Structure

```
apps/api               backend NestJS + pont Baileys (module whatsapp/)
apps/web               frontend React/Vite
packages/shared-types  contrat typé partagé (DTO WhatsApp + événements socket)
infra/caddy            reverse proxy + TLS
```
