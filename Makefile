SHELL := /bin/bash
COMPOSE := docker compose
DEV := docker compose -f docker-compose.yml -f docker-compose.dev.yml

.DEFAULT_GOAL := help

help: ## Affiche cette aide
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

env: ## Crée .env depuis .env.example si absent
	@test -f .env || (cp .env.example .env && echo "✅ .env créé — pense à régénérer les secrets (openssl rand -hex 32)")

config: env ## Génère la config LiveKit (IP média + ports)
	@sh infra/scripts/gen-config.sh

up: config ## Build + démarre toute la pile (mode images, prod-like)
	$(COMPOSE) up --build -d
	@echo ""
	@echo "→ Ouvre https://app.localhost (accepte le certificat local au 1er accès,"
	@echo "  ou lance 'make trust-ca' pour l'installer définitivement)."
	@echo "→ OTP de connexion: 'make logs-backend'."

dev: config ## Démarre en mode développement (hot reload back + front)
	$(DEV) up --build

down: ## Arrête la pile
	$(COMPOSE) down

clean: ## Arrête et SUPPRIME les volumes (⚠ efface la base de données)
	$(COMPOSE) down -v

logs: ## Suit les logs de toute la pile
	$(COMPOSE) logs -f --tail=100

logs-backend: ## Logs du backend (l'OTP s'y affiche en dev)
	$(COMPOSE) logs -f backend

ps: ## État des services
	$(COMPOSE) ps

migrate: ## Applique les migrations Prisma
	$(COMPOSE) run --rm migrate

seed: ## Insère des données de démo (2 utilisateurs + 1 conversation)
	$(COMPOSE) run --rm migrate sh -c "cd apps/api && pnpm exec prisma db seed"

restart: ## Redémarre backend + frontend
	$(COMPOSE) restart backend frontend

trust-ca: ## Extrait la CA locale de Caddy (HTTPS de confiance)
	@sh infra/scripts/trust-ca.sh

.PHONY: help env config up dev down clean logs logs-backend ps migrate seed restart trust-ca
