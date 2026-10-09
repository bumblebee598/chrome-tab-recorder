.PHONY: dev dev-down test test-backend test-extension build-ext zip-ext lint fixtures

# Start emulators + api + worker (Firestore :8080, Cloud Tasks :8123, api :8000, worker :8081)
dev:
	docker compose up --build

dev-down:
	docker compose down -v

test: test-backend test-extension

test-backend:
	cd backend && uv run pytest -q

test-extension:
	cd extension && npm test

build-ext:
	cd extension && npm run build
	@echo "Load extension/.output/chrome-mv3 as an unpacked extension in chrome://extensions"

zip-ext:
	cd extension && npm run zip

lint:
	cd backend && uv run ruff check app tests
	cd extension && npx tsc --noEmit

# Generate synthetic test media (requires ffmpeg)
fixtures:
	./scripts/make_fixture_media.sh

# Random values for backend/.env — paste the output in
gen-secrets:
	@echo "SESSION_JWT_SECRET=$$(openssl rand -hex 32)"
	@echo "WEBHOOK_SECRET=$$(openssl rand -hex 32)"
	@echo "TOKEN_FERNET_KEY=$$(openssl rand -base64 32 | tr '+/' '-_')"
