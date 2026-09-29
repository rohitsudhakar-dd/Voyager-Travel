// Package logging emits the shared Voyager log schema
// (05-FUNCTIONALITY.md § 12).
//
// One schema across four languages is what makes the log-correlation demo
// work, so the field names here are not negotiable. `dd.trace_id` injection
// arrives in phase 8 once the tracer exists.
package logging

import (
	"os"
	"time"

	"github.com/rs/zerolog"
)

// New returns a logger that writes the shared schema to stdout.
func New(service, env, version string) zerolog.Logger {
	zerolog.TimeFieldFormat = time.RFC3339Nano
	zerolog.TimestampFieldName = "timestamp"
	zerolog.MessageFieldName = "message"
	// Datadog's canonical level name, not zerolog's default "level".
	zerolog.LevelFieldName = "status"
	zerolog.LevelFatalValue = "critical"
	zerolog.LevelPanicValue = "critical"

	level := zerolog.InfoLevel
	if parsed, err := zerolog.ParseLevel(os.Getenv("LOG_LEVEL")); err == nil && os.Getenv("LOG_LEVEL") != "" {
		level = parsed
	}

	return zerolog.New(os.Stdout).
		Level(level).
		With().
		Timestamp().
		Str("service", service).
		Str("env", env).
		Str("version", version).
		Logger()
}
