# Reprise du travail multi-compte (handoff)

> But : reprendre le développement multi-compte de wa-bridge sur une autre machine.
> Ce fichier ne contient **aucun secret** (le repo est public) — les valeurs sensibles
> se recréent localement dans `.env` (cf. étape 3).

Dernière mise à jour : 2026-07-01.

---

## 1. Où en est le travail

Le multi-compte (lier 2–4 comptes WhatsApp sur la même interface) est découpé en phases,
une PR chacune. **Deux PR sont ouvertes, non mergées, non déployées.**

| Phase | Branche | PR | Base | Contenu |
|------|---------|----|------|---------|
| 1 — Fondation | `feat/multi-account-foundation` | #7 | `main` | `account_id` partout (migration `7_multi_account` **non-destructive**), service refondu en `AccountManager` (N sockets Baileys / 1 process), `GET /wa/accounts`. Comportement mono-compte inchangé. |
| 2 — Liaison + bascule | `feat/multi-account-linking` | #8 | `feat/multi-account-foundation` (PR **empilée**) | Lier / basculer / envoyer par compte : `createAccount`/`connectAccount`/`renameAccount`/`deleteAccount`, events `wa:account-*`, caches RTK Query scopés par `accountId`, UI `AccountBar` + `AddAccountModal` (QR). |

La branche **`feat/multi-account-linking` contient tout** (Phase 1 + Phase 2) : c'est celle
à récupérer pour continuer.

État qualité (au moment du handoff) : `tsc` API + web ✅, `pnpm build` ✅, `pnpm lint` ✅.
Revue adversariale passée : 5 findings (dont 1 critique perte de données sur `deleteAccount`)
+ 1 régression, **tous corrigés et re-vérifiés (0 problème)**.

### Reste à faire
- **Tester en réel** la Phase 2 : lier un 2ᵉ compte via la modale « + », vérifier
  bascule + envoi, puis « Délier ».
- **Phase 3 (non commencée)** : vue fusionnée par personne (« option C ») — timeline
  unifiée d'un contact présent sur ≥2 comptes, avec le **nom du compte affiché en petit
  sous chaque message uniquement si la conversation couvre plus d'un compte**.
- Ne **rien déployer** sans validation manuelle : la migration touche la base live ;
  le merge des PR est la porte de validation.

---

## 2. Récupérer le code sur la nouvelle machine

```bash
git clone git@github.com:james2001/wa-bridge.git
cd wa-bridge
git fetch origin
git checkout feat/multi-account-linking      # tip = Phase 1 + Phase 2
```

Prérequis : Docker + Docker Compose. (Pour le dev hors Docker : Node ≥ 20 — idéalement 22 —
et `corepack enable` pour disposer de `pnpm`.)

---

## 3. Recréer la configuration locale (`.env`)

Le vrai `.env` est **gitignoré** (secrets) : il ne voyage pas avec le repo, à recréer.

```bash
make env            # copie .env.example -> .env si absent
```

Puis éditer `.env` :
- `HTTP_PORT` / `HTTPS_PORT` : laisser `80`/`443` s'ils sont **libres**. S'ils sont pris
  (autre reverse proxy, comme sur la machine précédente), choisir des ports libres
  (ex. `8444` / `8553`) et **accéder via `https://app.localhost:<HTTPS_PORT>`**. Penser à
  aligner `CORS_ORIGINS` (`https://app.localhost:<HTTPS_PORT>`).
- `APP_PASSWORD` : le mot de passe qui protège l'accès à l'app.
- `POSTGRES_PASSWORD` + `DATABASE_URL` : mot de passe DB (cohérents entre les deux lignes).
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` : `openssl rand -hex 32` pour chacun.

---

## 4. Démarrer

```bash
make up          # build + démarre toute la pile (prod-like)   — OU
make dev         # mode dev (hot reload back + front)
make migrate     # applique les migrations Prisma (dont 7_multi_account)
make logs-backend   # suivre les logs du backend
```

Accès : **`https://app.localhost:<HTTPS_PORT>`** puis login avec `APP_PASSWORD`.

### ⚠️ La session WhatsApp et la base ne voyagent PAS
Les volumes Docker `wa_auth` (session Baileys) et la base Postgres sont **locaux à
l'ancienne machine**. Sur la nouvelle, la pile démarre à vide → le compte principal
apparaît en état **QR** : il faut **re-scanner** depuis WhatsApp (Appareils connectés →
Lier un appareil). L'historique (chats/messages) se reconstruit ensuite par la synchro ;
seule la session `wa_auth` est sensible.
*(Option avancée : migrer manuellement le volume `whatapp-clone_wa_auth` de l'ancienne
machine pour éviter un re-scan — sinon, un simple re-scan suffit.)*

### Confiance HTTPS pour les tests navigateur
Le certificat Caddy auto-signé (`app.localhost`) doit être approuvé, sinon les appels
`/api` sont bloqués (« Impossible de charger les discussions »).
```bash
make trust-ca    # extrait la CA locale dans infra/caddy/certs/ (gitignoré)
# puis l'installer dans le magasin système / Chrome, et redémarrer Chrome
```

---

## 5. Vérifier (build / lint) pendant le dev

`pnpm` n'est pas toujours sur le PATH → `corepack enable` (ou `corepack pnpm …`).

```bash
pnpm install --no-frozen-lockfile   # pas de lockfile committé (cf. Dockerfiles/CI)
pnpm shared:build                   # compile packages/shared-types (à faire avant les typechecks)
pnpm build                          # build shared + api + web (= vérif de compilation fiable)
pnpm lint                           # ESLint (0 erreur attendu ; 1 warning préexistant Composer.tsx)
```

Notes :
- La vérif de compilation fiable est **`pnpm build`** (ou `docker compose build`, ce que fait
  la CI). Le `pnpm typecheck` global peut buter côté web sur la référence de projet TS
  (`TS6310`) — non bloquant, contourné par le build.
- Pour typechecker **l'API** seule : `cd apps/api && npx tsc --noEmit -p tsconfig.json`.

---

## 6. Points d'architecture à garder en tête (multi-compte)

- **Invariant critique** : le compte `'default'` mappe sur les **racines historiques**
  `/data/wa-auth` et `/data/media-cache` (`authDirFor`/`mediaDirFor`) → sa session live
  n'est **jamais** invalidée. Les comptes secondaires vivent dans des **sous-dossiers**.
- `accountId` a pour défaut `'default'` **partout** (DTO, routes, events, inputs socket)
  → le comportement mono-compte reste identique.
- Caches RTK Query **re-keyés par `accountId`** (un même JID sur 2 comptes ne collisionne
  plus) ; le pont socket applique les mises à jour au compte porté par l'événement.
- `deleteAccount` est **durci** : id validé (jamais de traversée vers la racine partagée),
  purge DB atomique = point de commit (erreur propagée avant tout `rm`).
- `isLiveSession(s) = (s.sock !== null || s.connecting)` : une session « fantôme » créée par
  `ensureSession` depuis un chemin de **lecture** n'écrase pas le vrai statut DB d'un compte
  délié et n'est pas rediffusée.

---

## 7. Reprendre avec l'assistant

Le contexte détaillé (choix techniques, pièges Baileys/LID, procédure de re-scan, etc.)
est conservé dans la mémoire projet de l'assistant. Pour repartir : ouvrir le repo sur la
nouvelle machine et demander la **Phase 3** (ou de relire/tester #7 et #8).
