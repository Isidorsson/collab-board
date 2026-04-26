package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Isidorsson/collab-board/internal/handlers"
	"github.com/Isidorsson/collab-board/internal/hub"
)

//go:embed all:web
var webFS embed.FS

func main() {
	addr := flag.String("addr", envOr("ADDR", ":8080"), "listen address")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	h := hub.New(log)

	web, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Error("embed web", "err", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(web)))
	mux.Handle("/ws", handlers.WS(h, log))
	mux.Handle("/healthz", handlers.Health())
	mux.Handle("/metrics", handlers.Metrics(h))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Info("server listening", "addr", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
