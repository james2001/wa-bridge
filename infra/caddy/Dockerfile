# Proxy interne de la stack de production : Caddy + sa configuration, figés dans
# une image.
#
# Pourquoi une image plutôt qu'un bind-mount du Caddyfile comme en dev : une
# stack git Portainer clone le dépôt sur l'hôte PORTAINER (.24), alors que le
# conteneur tourne sur .21. Un `./infra/caddy/Caddyfile:/etc/caddy/Caddyfile`
# pointerait donc, côté .21, vers un chemin qui n'existe pas — et Docker créerait
# silencieusement un RÉPERTOIRE vide à la place, ce qui donne un Caddy qui
# démarre sur une configuration par défaut et sert un 404 à tout le monde.
#
# Contexte de build : la RACINE du dépôt (voir scripts/build-push.sh).
FROM caddy:2.8-alpine

COPY infra/caddy/Caddyfile.prod /etc/caddy/Caddyfile

# Échoue au build si la configuration est invalide, plutôt qu'au déploiement.
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

EXPOSE 80
