// Command server runs pricing-service: fare computation over the rule set in
// Postgres, held in memory and refreshed on a timer.
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

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"voyager/pricing-service/internal/api"
	"voyager/pricing-service/internal/chaos"
	"voyager/pricing-service/internal/config"
	"voyager/pricing-service/internal/logging"
	"voyager/pricing-service/internal/rules"
	"voyager/pricing-service/internal/tracing"
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

	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		log.Fatal().Str("error_message", err.Error()).Msg("Service failed to start")
	}
	pool, err := tracing.NewPool(ctx, poolConfig, cfg.Service)
	if err != nil {
		log.Fatal().Str("error_message", err.Error()).Msg("Service failed to start")
	}
	defer pool.Close()

	redisOptions, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatal().Str("error_message", err.Error()).Msg("Service failed to start")
	}
	rdb := tracing.WrapRedis(redis.NewClient(redisOptions), cfg.Service)
	defer rdb.Close()

	store := rules.NewStore(pool, log)
	if err := store.Start(ctx, cfg.RuleRefreshInterval); err != nil {
		log.Fatal().Str("error_message", err.Error()).Msg("Fare rules failed to load")
	}

	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           api.NewServer(cfg, log, store, chaos.New(rdb), pool, rdb).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
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
