// Package config resolves runtime configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Service string
	Env     string
	Version string
	Port    int

	DatabaseURL string
	RedisURL    string

	// Fare rules are reloaded on this interval. The demo edits rules rarely,
	// but a stale in-memory cache that never refreshes is the kind of thing
	// that bites during a live session.
	RuleRefreshInterval time.Duration

	ReadinessTimeout time.Duration
}

func Load() Config {
	return Config{
		Service:             env("DD_SERVICE", "voyager-pricing"),
		Env:                 env("DD_ENV", "demo"),
		Version:             env("DD_VERSION", "dev"),
		Port:                envInt("PORT", 4020),
		DatabaseURL:         databaseURL(),
		RedisURL:            env("REDIS_URL", "redis://redis:6379"),
		RuleRefreshInterval: time.Duration(envInt("PRICING_RULE_REFRESH_SECONDS", 60)) * time.Second,
		ReadinessTimeout:    2 * time.Second,
	}
}

func databaseURL() string {
	if url := os.Getenv("DATABASE_URL"); url != "" {
		return url
	}
	return fmt.Sprintf(
		"postgres://%s:%s@%s:%s/%s?search_path=voyager,public",
		env("POSTGRES_USER", "voyager"),
		os.Getenv("POSTGRES_PASSWORD"),
		env("POSTGRES_HOST", "postgres"),
		env("POSTGRES_PORT", "5432"),
		env("POSTGRES_DB", "voyager"),
	)
}

// Redacted returns the config as loggable fields. Passwords never appear.
func (c Config) Redacted() map[string]any {
	return map[string]any{
		"port":                  c.Port,
		"env":                   c.Env,
		"version":               c.Version,
		"rule_refresh_seconds":  int(c.RuleRefreshInterval.Seconds()),
		"postgres_host":         env("POSTGRES_HOST", "postgres"),
		"postgres_db":           env("POSTGRES_DB", "voyager"),
		"redis_url":             c.RedisURL,
		"readiness_timeout_sec": c.ReadinessTimeout.Seconds(),
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if value := os.Getenv(key); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			return parsed
		}
	}
	return fallback
}
