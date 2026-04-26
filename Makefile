.PHONY: run build fmt test check loadtest loadtest-slow docker docker-run lint tidy

run:
	go run ./cmd/server

build:
	CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/collab-board ./cmd/server

fmt:
	go fmt ./...

test:
	go test -race ./...

# One-shot CI gate: format, vet, and race-tested unit tests.
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
