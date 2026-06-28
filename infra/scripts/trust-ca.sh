#!/usr/bin/env sh
# Extrait la CA racine locale de Caddy pour que le navigateur/OS fasse confiance
# au HTTPS de dev (évite l'avertissement de certificat, requis pour un parcours fluide).
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUT="infra/caddy/certs/caddy-local-root.crt"

echo "→ Extraction de la CA racine de Caddy…"
docker compose cp \
  caddy:/data/caddy/pki/authorities/local/root.crt "$OUT" 2>/dev/null || {
  echo "⚠  Caddy n'est pas démarré ou la CA n'existe pas encore. Lance d'abord 'make up'." >&2
  exit 1
}

echo "✅ CA extraite: $OUT"
echo ""
echo "Pour l'installer (Linux Debian/Ubuntu):"
echo "  sudo cp $OUT /usr/local/share/ca-certificates/caddy-local-root.crt"
echo "  sudo update-ca-certificates"
echo ""
echo "Firefox: importer $OUT dans Paramètres → Vie privée → Certificats → Autorités."
echo "Chrome:  chrome://settings/certificates → Autorités → Importer."
