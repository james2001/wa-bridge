#!/usr/bin/env bash
# =============================================================================
#  build-push.sh — produit les images de PRODUCTION et les pousse au registre.
#
#  Le build est délégué en SSH à une machine de la même architecture que les
#  nœuds Swarm. Les nœuds visés ici sont des Raspberry Pi (aarch64) alors que le
#  poste de dev est en amd64 : buildx sous QEMU donnerait le même résultat, mais
#  Baileys et Prisma tirent des binaires natifs et l'émulation fait passer le
#  build d'une dizaine de minutes à plus d'une heure. Autant compiler là où ça
#  tourne. Si ton poste a déjà la bonne architecture, mets BUILD_HOST=local.
#
#      ./scripts/build-push.sh              # tag = <date UTC>-<sha7 de HEAD>
#      ./scripts/build-push.sh 20260807-abc1234
#
#  La machine de build REFETCHE le dépôt à l'exact SHA de HEAD : ce qui est
#  construit est ce qui est publié, jamais l'état non commité du poste. D'où le
#  refus de tourner si HEAD n'est pas poussé.
#
#  Après un push réussi, le script réécrit les tags dans compose.prod.yaml —
#  c'est ce fichier qui dit ce que le Swarm exécute. Commite-le, pousse-le, puis
#  redéploie la stack.
#
#  --- Configuration ---
#  Toutes les valeurs ci-dessous se surchargent par variable d'environnement, et
#  sont lues depuis `scripts/build-push.env` s'il existe (fichier local, ignoré
#  par git : ce dépôt est public, l'adressage d'une infra n'y a pas sa place).
#
#      # scripts/build-push.env
#      REGISTRY=registry.example.com/monorg
#      BUILD_HOST=10.0.0.10
#      BUILD_SSH_JUMP=user@bastion.example.com   # optionnel
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE_FILE="compose.prod.yaml"

# shellcheck source=/dev/null
[ -f scripts/build-push.env ] && . scripts/build-push.env

# Préfixe des images, sans le nom : registre + éventuel espace de noms.
# Doit être identique à la variable REGISTRY de la stack.
REGISTRY="${REGISTRY:-}"
# Machine qui compile. `local` pour construire sur le poste courant.
BUILD_HOST="${BUILD_HOST:-}"
BUILD_USER="${BUILD_USER:-$USER}"
BUILD_DIR="${BUILD_DIR:-/opt/builds/wa-bridge}"
BUILD_SSH_KEY="${BUILD_SSH_KEY:-}"
# Rebond SSH éventuel (bastion). Vide => connexion directe.
BUILD_SSH_JUMP="${BUILD_SSH_JUMP:-}"

if [ -z "$REGISTRY" ] || [ -z "$BUILD_HOST" ]; then
  echo "ERREUR: REGISTRY et BUILD_HOST sont requis (voir l'en-tête du script)." >&2
  exit 1
fi

# Le dépôt est cloné par la machine de build : il lui faut une URL qu'elle peut
# atteindre sans les clés du poste, donc HTTPS plutôt que git@.
REPO_URL="${REPO_URL:-$(git remote get-url origin |
  sed -E 's#^git@([^:]+):#https://\1/#')}"

# --- Le SHA construit doit exister sur le distant -----------------------------
# Sans cette garde, un HEAD local non poussé produirait un build de ce qui est
# EN LIGNE tout en portant le numéro du commit local : une image mal nommée que
# personne ne remarque.
SHA_FULL="$(git rev-parse HEAD)"
SHA_SHORT="$(git rev-parse --short=7 HEAD)"
if ! git ls-remote origin | grep -q "^${SHA_FULL}"; then
  echo "ERREUR: le commit ${SHA_SHORT} n'est pas sur origin. Pousse d'abord." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "AVERTISSEMENT: modifications non commitées — elles NE SERONT PAS construites." >&2
fi

TAG="${1:-$(date -u +%Y%m%d)-${SHA_SHORT}}"

API_IMAGE="${REGISTRY}/wa-bridge_api:${TAG}"
WEB_IMAGE="${REGISTRY}/wa-bridge_web:${TAG}"
PROXY_IMAGE="${REGISTRY}/wa-bridge_proxy:${TAG}"

echo "==> Build de ${TAG} sur ${BUILD_HOST}"

# Le corps du build, exécuté tel quel en local ou passé à bash via SSH.
# Heredoc QUOTÉ ('BUILD') : rien n'est interpolé ici, les $1..$6 sont résolus par
# le bash distant à partir des arguments passés plus bas.
BUILD_SCRIPT=$(cat <<'BUILD'
set -euo pipefail
REPO_URL="$1"; BUILD_DIR="$2"; SHA="$3"; API_IMAGE="$4"; WEB_IMAGE="$5"; PROXY_IMAGE="$6"

if [ ! -d "$BUILD_DIR/.git" ]; then
  sudo mkdir -p "$(dirname "$BUILD_DIR")"
  sudo chown "$(id -u):$(id -g)" "$(dirname "$BUILD_DIR")"
  git clone "$REPO_URL" "$BUILD_DIR"
fi
cd "$BUILD_DIR"
git fetch --all --prune
# --detach : ce clone est un plan de travail jetable, pas une branche à suivre.
git checkout --detach "$SHA"
git clean -fdx

echo "--- API (NestJS + Baileys) ---"
docker build -f apps/api/Dockerfile --target runtime -t "$API_IMAGE" .

echo "--- WEB (SPA React) ---"
# VITE_SOCKET_URL VIDE, et c'est délibéré : le front ouvre alors sa socket sur
# la MÊME origine que la page. Cette valeur est figée dans le bundle au build —
# l'omettre laisserait le défaut du Dockerfile (https://app.localhost) et le
# temps réel serait mort en production sans que rien d'autre ne casse.
docker build -f apps/web/Dockerfile --target runtime \
  --build-arg VITE_API_BASE_URL=/api \
  --build-arg VITE_SOCKET_URL= \
  -t "$WEB_IMAGE" .

echo "--- PROXY (Caddy + Caddyfile.prod) ---"
docker build -f infra/caddy/Dockerfile -t "$PROXY_IMAGE" .

# Garde-fou : compose.prod.yaml appelle prisma par ce chemin exact. S'il bouge
# (montée de pnpm, changement de layout), la stack redémarrerait en boucle sur
# un "no such file" au lieu d'échouer ici, où c'est lisible.
docker run --rm --entrypoint sh "$API_IMAGE" -c "test -x ./node_modules/.bin/prisma" \
  || { echo "ERREUR: ./node_modules/.bin/prisma absent de l'image API" >&2; exit 1; }

for image in "$API_IMAGE" "$WEB_IMAGE" "$PROXY_IMAGE"; do
  echo "--- push $image ---"
  docker push "$image"
done
BUILD
)

if [ "$BUILD_HOST" = "local" ]; then
  bash -c "$BUILD_SCRIPT" -- \
    "$REPO_URL" "$BUILD_DIR" "$SHA_FULL" "$API_IMAGE" "$WEB_IMAGE" "$PROXY_IMAGE"
else
  SSH_OPTS=(-o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new)
  [ -n "$BUILD_SSH_KEY" ] && SSH_OPTS+=(-i "$BUILD_SSH_KEY")
  if [ -n "$BUILD_SSH_JUMP" ]; then
    JUMP_CMD="ssh"
    [ -n "$BUILD_SSH_KEY" ] && JUMP_CMD="ssh -i ${BUILD_SSH_KEY}"
    SSH_OPTS+=(-o "ProxyCommand=${JUMP_CMD} -W %h:%p ${BUILD_SSH_JUMP}")
  fi
  ssh "${SSH_OPTS[@]}" "${BUILD_USER}@${BUILD_HOST}" bash -s -- \
    "$REPO_URL" "$BUILD_DIR" "$SHA_FULL" "$API_IMAGE" "$WEB_IMAGE" "$PROXY_IMAGE" \
    <<< "$BUILD_SCRIPT"
fi

echo "==> Mise à jour des tags dans ${COMPOSE_FILE}"
sed -i -E "s#(wa-bridge_(api|web|proxy)):[^[:space:]]+#\1:${TAG}#g" "$COMPOSE_FILE"

cat <<EOF

Images publiées :
  ${API_IMAGE}
  ${WEB_IMAGE}
  ${PROXY_IMAGE}

Suite :
  git add ${COMPOSE_FILE} && git commit -m "deploy: images ${TAG}" && git push
  puis redéployer la stack (Portainer : « Pull and redeploy »).
EOF
