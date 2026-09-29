// Command server runs search-service: the fan-out to the availability
// providers, the result cache, and the paginated read side.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"voyager/search-service/internal/chaos"
	"voyager/search-service/internal/config"
	"voyager/search-service/internal/handlers"
	"voyager/search-service/internal/logging"
	"voyager/search-service/internal/tracing"
)

func main() {
	cfg := config.Load()
	log := logging.New(cfg.Service, cfg.Env, cfg.Version)

	// First, and before any client is constructed: the contribs patch nothing
	// retroactively, so anything built above this line is invisible.
	stopTracing := tracing.Start(cfg.Service, cfg.Env, cfg.Version)
	defer stopTracing()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	redisOptions, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatal().Str("error_message", err.Error()).Msg("Service failed to start")
	}
	rdb := tracing.WrapRedis(redis.NewClient(redisOptions), cfg.Service)
	defer rdb.Close()

	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           handlers.NewServer(cfg, log, chaos.New(rdb), rdb).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		// A cold search fans out to four providers on a three-second budget,
		// so the write timeout has to sit comfortably above that.
		WriteTimeout: 30 * time.Second,
	}

	go func() {
		// Rule 7 of the log schema: one structured startup line with the
		// resolved config. During a demo it is the fastest way to prove which
		// version is running.
		log.Info().Fields(cfg.Redacted()).Msg("Service started")
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error().Str("error_message", err.Error()).Msg("Server stopped unexpectedly")
			stop()
		}
	}()

	<-ctx.Done()
	log.Info().Msg("Shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Error().Str("error_message", err.Error()).Msg("Graceful shutdown failed")
		os.Exit(1)
	}
}
