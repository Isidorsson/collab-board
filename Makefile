.PHONY: run dev frontend-install frontend-build frontend-dev build fmt test check loadtest loadtest-slow docker docker-run lint tidy clean

# Default development entry point. Runs the Go backend and assumes the
# frontend has been built at least once. For HMR-driven dev, use `make dev`.
run:
	go run ./cmd/server

# Two-process dev: Vite on :5173 with HMR + proxied /ws, Go on :8080.
# Both run in the foreground; Ctrl-C stops them.
dev:
	@echo "Starting Vite (5173) and Go server (8080)..."
	@cd frontend && yarn dev & \
		go run ./cmd/server; \
		kill %1 2>/dev/null || true

# Frontend pipeline. Targets are idempotent and safe to chain.
frontend-install:
	cd frontend && yarn install --frozen-lockfile || cd frontend && yarn install

frontend-build: frontend-install
	cd frontend && yarn build

frontend-dev: frontend-install
	cd frontend && yarn dev

# Production binary. Builds the frontend first so the embedded dist tree
# is current. The resulting binary needs no external assets.
build: frontend-build
	CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/collab-board ./cmd/server

fmt:
	go fmt ./...

test:
	go test -race ./...

# One-shot CI gate: format, vet, race-tested unit tests.
check: fmt lint test

loadtest:
	go run ./cmd/loadtest -n 200 -dur 30s

loadtest-slow:
	go run ./cmd/loadtest -n 50 -dur 20s -slow

docker:
	docker build -t collab-board:dev .

docker-run:
	docker run --rm -p 8080:8080 collab-board:dev

lint:
	go vet ./...

tidy:
	go mod tidy

clean:
	rm -rf bin cmd/server/web/dist/* frontend/dist frontend/node_modules
	@touch cmd/server/web/dist/.gitkeep
