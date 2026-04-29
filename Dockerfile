# --- frontend stage: produce cmd/server/web/dist/ ---------------------------
FROM node:lts-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/yarn.lock* ./
RUN yarn install --frozen-lockfile || yarn install
COPY frontend/ ./
RUN yarn build

# --- backend stage: embed dist and build single binary ----------------------
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /src/cmd/server/web/dist ./cmd/server/web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/collab-board ./cmd/server

# --- runtime: distroless, nonroot ------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/collab-board /collab-board
EXPOSE 8080
USER nonroot:nonroot
# No HEALTHCHECK: distroless ships no shell or curl. Use the platform's
# liveness probe against /healthz (Railway, Cloud Run, and Kubernetes
# all support HTTP probes natively).
ENTRYPOINT ["/collab-board"]
