# Contribuer à wa-bridge

Merci de ton intérêt ! Quelques règles simples pour garder le projet sain.

## ⚠️ Avant tout

wa-bridge est un **pont non officiel** vers WhatsApp (via [Baileys](https://github.com/WhiskeySockets/Baileys)).
Se connecter à un compte WhatsApp via un client tiers est **contraire aux CGU de WhatsApp**
(risque de blocage du compte). Le projet n'est **ni affilié ni approuvé par Meta/WhatsApp**.
Voir la section « À lire avant » du [README](README.md).

## Prérequis

- **Docker** + **Docker Compose**, **Make**
- **Node 22+** et **pnpm 9** (via `corepack enable`) pour le lint/typecheck en local

## Démarrer

```bash
make up             # build + démarre la pile (crée .env au besoin)
make dev            # mode dev (hot reload back + front)
make logs-backend   # logs backend
```

Accès : `https://app.localhost` (ou le `HTTPS_PORT` configuré). Connexion par
`APP_PASSWORD`, puis scan du QR depuis ton téléphone.

## Qualité (vérifie avant d'ouvrir une PR)

La CI (GitHub Actions) lance ces vérifications ; lance-les en local d'abord :

```bash
pnpm install        # installe les dépendances du monorepo
pnpm lint           # ESLint (doit passer sans erreur)
pnpm typecheck      # tsc --noEmit sur les 3 paquets
docker compose build  # build complet (typecheck via nest/vite + Dockerfiles)
```

- **Lint** : `pnpm lint:fix` corrige l'auto-corrigeable.
- **Types** : pas de `tsc` cassé ; `any` toléré uniquement aux frontières Baileys/Prisma.
- **Le contrat partagé** (`packages/shared-types`) est la source de vérité des DTO et des
  événements socket : modifie-le en premier, puis back et front.

## Structure

```
apps/api               backend NestJS + pont Baileys (module whatsapp/)
apps/web               frontend React/Vite
packages/shared-types  contrat typé partagé (DTO + événements socket)
infra/caddy            reverse proxy + TLS
```

## Style de commits

Le dépôt suit **Conventional Commits** : `feat(...)`, `fix(...)`, `chore(...)`, `docs(...)`…
Messages en français acceptés. Un commit = une intention cohérente.

## Pull requests

1. Branche depuis `main`/`master`.
2. Garde la PR ciblée ; décris le _quoi_ et le _pourquoi_.
3. CI verte (lint + build) obligatoire.
4. Pas de secret, `.env`, certificat, dump DB ou export de conversation dans le diff.

## Sécurité & données

Ne committe jamais de session WhatsApp (`wa_auth`), de `.env`, ni de données personnelles
(messages, contacts). Signale les vulnérabilités en privé plutôt que via une issue publique.
