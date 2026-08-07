# Déploiement en production (Docker Swarm)

> `make up` couvre le poste de dev. Ce document couvre l'autre cas : une
> instance qui tourne en permanence sur un serveur, derrière un reverse proxy
> qui porte le TLS.
>
> Ce dépôt est public : il ne contient aucune adresse, aucun domaine et aucun
> secret. Tout ce qui est propre à un hébergement passe par des variables.

## Vue d'ensemble

```
navigateur ──HTTPS/WSS──▶ reverse proxy d'entrée (TLS, auth éventuelle)
                                 │  HTTP, port APP_PORT du nœud
                                 ▼
                          proxy (Caddy, seul port publié)
                            ├── /api/*        ──▶ backend  (NestJS + Baileys)
                            ├── /socket.io/*  ──▶ backend
                            └── /             ──▶ frontend (SPA, nginx)

backend ──▶ PostgreSQL externe (cache des discussions)
backend ──▶ volume wa_auth (session WhatsApp — sensible)
```

Différences assumées avec `docker-compose.yml` (dev) :

| | dev | production |
|---|---|---|
| Images | construites localement | tirées d'un registre (Swarm ignore `build:`) |
| TLS | Caddy, CA interne | reverse proxy d'entrée |
| PostgreSQL | conteneur de la pile | serveur externe |
| Ports 80/443 | publiés | un seul port `APP_PORT`, non public |

## Prérequis

- Un Swarm (`docker swarm init` suffit pour un nœud) et un registre accessible
  depuis les nœuds.
- Une machine de build de la **même architecture** que les nœuds.
- Une base PostgreSQL vide et un rôle qui en est propriétaire.
- Un reverse proxy d'entrée capable de **relayer les WebSockets** — sans quoi
  l'application se charge, se connecte, et n'affiche jamais un message en temps
  réel.

## 1. Construire et publier les images

Renseigner `scripts/build-push.env` (ignoré par git) :

```sh
REGISTRY=registry.example.com/monorg
BUILD_HOST=10.0.0.10          # `local` pour construire sur le poste courant
BUILD_USER=deploy
BUILD_SSH_KEY=~/.ssh/id_ed25519
BUILD_SSH_JUMP=              # bastion éventuel
```

```sh
git push                      # le build se fait sur le SHA publié, pas sur le
./scripts/build-push.sh       # répertoire de travail local
```

Trois images sortent : `wa-bridge_api`, `wa-bridge_web`, `wa-bridge_proxy`. Le
script réécrit ensuite les tags dans `compose.prod.yaml` : **commiter ce
fichier**, c'est lui qui dit quelle version tourne.

> `VITE_SOCKET_URL` est figée dans le bundle au build, et le script la laisse
> **vide** exprès : le front ouvre alors sa socket sur la même origine que la
> page. Une valeur oubliée ici donne une application qui s'affiche
> parfaitement et dont le temps réel est mort.

## 2. Variables de la stack

Obligatoires — aucune n'a de valeur par défaut, une absence casse le
déploiement plutôt que de faire tourner l'application avec un secret d'exemple :

| Variable | Rôle |
|---|---|
| `REGISTRY` | préfixe des images, identique à celui du build |
| `SWARM_NODE` | hostname du nœud qui porte les volumes (`docker node ls`) |
| `APP_PORT` | port publié sur l'hôte, cible du reverse proxy |
| `APP_DOMAIN` | domaine public (sert à `CORS_ORIGINS`) |
| `DATABASE_URL` | `postgresql://user:pass@host:port/base?schema=public` |
| `APP_PASSWORD` | **la seule barrière applicative devant les discussions** |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | `openssl rand -hex 32`, distincts |

Optionnelles : `JWT_ACCESS_TTL` (15m), `JWT_REFRESH_TTL` (30d), et les
`AGENT_*` — l'API server-to-server est **désactivée** tant que `AGENT_API_KEY`
est vide, ce qui est le défaut voulu : cette porte n'a pas de JWT devant elle,
seulement une clé statique.

## 3. Déployer

```sh
docker stack deploy -c compose.prod.yaml wa-bridge
docker service ls | grep wa-bridge
```

L'ordre se règle tout seul : `migrations` applique le schéma, `backend` attend
en boucle que `prisma migrate status` soit propre avant de démarrer (Swarm
n'implémente pas `depends_on`).

Puis, dans le navigateur : mot de passe `APP_PASSWORD`, puis scan du QR
(WhatsApp → *Appareils connectés* → *Lier un appareil*).

## 4. Reverse proxy d'entrée

Rien de particulier hormis le WebSocket. L'essentiel :

- relayer vers `http://<nœud>:APP_PORT` ;
- autoriser l'upgrade WebSocket (`/socket.io/`) ;
- laisser passer les corps de requête volumineux pour l'envoi de médias
  (nginx : `client_max_body_size 100m;`) ;
- transmettre `X-Forwarded-For` / `X-Forwarded-Proto`.

Une authentification supplémentaire à ce niveau (basic auth, liste
d'adresses, VPN) est une bonne idée : elle transforme `APP_PASSWORD` en
deuxième barrière au lieu de la seule.

## 5. Ce qu'il faut savoir avant l'incident

**La session WhatsApp est unique.** Le backend est un appareil lié : son état
d'authentification vit dans le volume `wa_auth`, et deux processus sur ce volume
invalident la session côté WhatsApp — QR à re-scanner. D'où `replicas: 1` et
`update_config.order: stop-first`. Ne pas scaler ce service.

**La stack est épinglée sur un nœud.** `wa_auth` et `media_cache` sont des
volumes locaux : replanifié ailleurs, le backend démarre sur un volume vide et
redemande un QR. Conséquence acceptée : ce nœud tombe, le service est
indisponible jusqu'à son retour. Un stockage réseau lèverait la contrainte mais
mettrait une base de session sur du NFS, ce qui est un bon moyen de la corrompre.

**Sauvegarder `wa_auth`, pas seulement la base.** La base est un cache
reconstructible ; le volume, lui, est ce qui évite de re-lier le téléphone.

```sh
docker run --rm -v wa-bridge_wa_auth:/data:ro -v "$PWD":/out alpine \
  tar czf /out/wa-auth-$(date +%F).tar.gz -C /data .
```

Cette archive contient les identifiants de la session : elle vaut l'accès à
l'intégralité des discussions. À traiter comme une clé privée.

**Mettre à jour** = `./scripts/build-push.sh`, commit du `compose.prod.yaml`,
puis redéploiement. Le backend est coupé avant d'être remplacé (`stop-first`),
il y a donc une courte interruption : c'est voulu.
