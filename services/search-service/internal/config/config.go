// Package config resolves runtime configuration from the environment.
package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	Service string
	Env     string
	Version string
	Port    int

	RedisURL       string
	GdsBaseURL     string
	PricingBaseURL string

	ReadinessTimeout time.Duration
}

func Load() Config {
	return Config{
		Service:          env("DD_SERVICE", "voyager-search"),
		Env:              env("DD_ENV", "demo"),
		Version:          env("DD_VERSION", "dev"),
		Port:             envInt("PORT", 4010),
		RedisURL:         env("REDIS_URL", "redis://redis:6379"),
		GdsBaseURL:       env("GDS_BASE_URL", "http://mock-gds:4900"),
		PricingBaseURL:   env("PRICING_BASE_URL", "http://pricing-service:4020"),
		ReadinessTimeout: 2 * time.Second,
	}
}

// Redacted returns the config as loggable fields. Nothing here is secret, but
// the method exists in every service so the startup line is uniform.
func (c Config) Redacted() map[string]any {
	return map[string]any{
		"port":                  c.Port,
		"env":                   c.Env,
		"version":               c.Version,
		"redis_url":             c.RedisURL,
		"gds_base_url":          c.GdsBaseURL,
		"pricing_base_url":      c.PricingBaseURL,
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
