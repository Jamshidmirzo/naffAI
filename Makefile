.PHONY: help up down logs migrate seed seed-tac test lint shell ps fresh deploy-frontend

help:
	@echo "naffAI — основные команды:"
	@echo "  make up               — поднять все контейнеры (db + web + frontend)"
	@echo "  make down             — остановить и удалить контейнеры"
	@echo "  make logs             — хвост логов всех сервисов"
	@echo "  make migrate          — миграции внутри контейнера web"
	@echo "  make seed             — демо-данные (operators, sales)"
	@echo "  make seed-tac         — обновить TAC-таблицу из встроенного датасета"
	@echo "  make test             — pytest в backend"
	@echo "  make lint             — ruff check + format"
	@echo "  make shell            — bash в контейнере web"
	@echo "  make fresh            — полный ресет БД и редеплой"
	@echo "  make deploy-frontend  — собрать и задеплоить фронт на Vercel prod (naffcrm.vercel.app)"

up:
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

migrate:
	docker compose exec web python manage.py migrate

seed:
	docker compose exec web python manage.py seed_channels
	docker compose exec web python manage.py seed_demo

seed-tac:
	docker compose exec web python manage.py seed_tac --builtin

test:
	cd backend && DJANGO_SETTINGS_MODULE=config.settings.test .venv/bin/python -m pytest

lint:
	cd backend && .venv/bin/ruff check . && .venv/bin/ruff format .

shell:
	docker compose exec web bash

ps:
	docker compose ps

fresh:
	docker compose down -v
	docker compose up --build -d

deploy-frontend:
	bash deploy/deploy-frontend.sh
