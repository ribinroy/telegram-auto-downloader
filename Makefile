# DownLee - one command to get from a fresh clone to a running app:
#
#     make up
#
# checks the system tools, installs the Python and frontend dependencies,
# writes .env (only if missing), creates the PostgreSQL user/database, builds
# the frontend and starts the app. Every step is also its own target and is
# skipped when already done, so `make up` is safe to run again. `make help`
# lists them all.

SHELL := /bin/bash
.DEFAULT_GOAL := help

PYTHON  ?= python3
VENV    := venv
PY      := $(VENV)/bin/python
PIP     := $(VENV)/bin/pip
# systemd unit name for `make service` / restart / logs
SERVICE ?= downlee

FRONTEND_SRC := $(shell find frontend/src frontend/public -type f 2>/dev/null) \
                frontend/index.html frontend/vite.config.ts frontend/package.json

.PHONY: help up install check env db frontend run dev test service restart logs update clean

help: ## Show this help
	@echo "DownLee - make targets:"
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "First time:   make up"
	@echo "As a service: make install env db service"

up: install env db run ## Everything: install, configure, create the database, start

install: check $(VENV)/.installed frontend/dist/index.html ## Install dependencies and build the frontend

check: ## Verify the system tools are installed
	@missing=0; \
	need() { if ! command -v "$$1" >/dev/null 2>&1; then echo "  missing: $$1  ($$2)"; missing=1; fi; }; \
	need $(PYTHON) "python3 3.10+"; \
	need node "Node.js 18+ - https://nodejs.org or: sudo apt install nodejs npm"; \
	need npm "comes with Node.js"; \
	need ffmpeg "sudo apt install ffmpeg"; \
	need psql "sudo apt install postgresql"; \
	if command -v $(PYTHON) >/dev/null && ! $(PYTHON) -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then \
	  echo "  $(PYTHON) is $$($(PYTHON) -V 2>&1) - DownLee needs 3.10+"; missing=1; fi; \
	if command -v $(PYTHON) >/dev/null && ! $(PYTHON) -c 'import venv, ensurepip' 2>/dev/null; then \
	  echo "  missing: python venv support  (sudo apt install python3-venv)"; missing=1; fi; \
	if [ $$missing = 1 ]; then echo "Install the above, then run make again."; exit 1; fi; \
	echo "system tools OK"

# Reinstalls when requirements.txt changes. yt-dlp goes in the venv because
# that is the binary the app runs (and the "Upgrade yt-dlp" job upgrades).
$(VENV)/.installed: requirements.txt
	@[ -x $(PY) ] || $(PYTHON) -m venv $(VENV)
	$(PIP) install --quiet --upgrade pip
	$(PIP) install --quiet -r requirements.txt yt-dlp
	@touch $@
	@echo "python dependencies installed"

# Rebuilds only when something under frontend/ changed
frontend/dist/index.html: $(FRONTEND_SRC) frontend/package-lock.json
	cd frontend && npm ci --no-audit --no-fund && npm run build

frontend: frontend/dist/index.html ## Build the frontend (if it changed)

env: ## Write .env with generated secrets (never overwrites an existing one)
	@$(PYTHON) scripts/bootstrap_env.py

db: env ## Create the PostgreSQL user + database from .env (asks for sudo once)
	@$(PYTHON) scripts/ensure_db.py

run: install env ## Start DownLee in the foreground
	$(PY) main.py

dev: install env ## Backend + Vite dev server with hot reload (Ctrl+C stops both)
	@trap 'kill 0' EXIT; $(PY) main.py & (cd frontend && npm run dev) & wait

test: install ## Run the backend and frontend tests
	$(PY) -m pytest -q
	cd frontend && npm test

# Writes the unit for this checkout and this user, then enables it on boot.
service: install env ## Install + start as a systemd service (SERVICE=downlee)
	@printf '%s\n' \
	  '[Unit]' \
	  'Description=DownLee Media Downloader' \
	  'After=network-online.target postgresql.service' \
	  'Wants=network-online.target' \
	  '' \
	  '[Service]' \
	  'Type=simple' \
	  'User=$(shell id -un)' \
	  'Group=$(shell id -gn)' \
	  'WorkingDirectory=$(CURDIR)' \
	  'Environment=PATH=$(CURDIR)/$(VENV)/bin:/usr/local/bin:/usr/bin:/bin' \
	  'ExecStart=$(CURDIR)/$(PY) $(CURDIR)/main.py' \
	  'Restart=always' \
	  'RestartSec=5' \
	  '' \
	  '[Install]' \
	  'WantedBy=multi-user.target' \
	  | sudo tee /etc/systemd/system/$(SERVICE).service >/dev/null
	sudo systemctl daemon-reload
	sudo systemctl enable --now $(SERVICE)
	@echo "$(SERVICE) is running - open http://localhost:$$(grep -oP '^WEB_PORT=\K.*' .env || echo 4444)"

restart: ## Restart the service without the Telegram startup greeting
	@touch .skip-greeting
	sudo systemctl restart $(SERVICE)

logs: ## Follow the service's log
	journalctl -fu $(SERVICE)

update: ## git pull, reinstall what changed, restart the service
	git pull --ff-only
	@$(MAKE) --no-print-directory install
	@$(MAKE) --no-print-directory restart

clean: ## Remove the venv, node_modules and the frontend build (keeps .env and data)
	rm -rf $(VENV) frontend/node_modules frontend/dist
