// Package httpx holds the request middleware shared by every handler.
package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"time"

	"github.com/rs/zerolog"
)

type contextKey int

const requestIDKey contextKey = iota

const RequestIDHeader = "X-Request-Id"

func RequestID(ctx context.Context) string {
	if value, ok := ctx.Value(requestIDKey).(string); ok {
		return value
	}
	return ""
}

func newRequestID() string {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		return "req_unknown"
	}
	return "req_" + hex.EncodeToString(buffer)
}

// WithRequestID honours an inbound request id so one id spans the whole hop
// chain, and mints one when the caller did not supply it.
func WithRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(RequestIDHeader)
		if id == "" {
			id = newRequestID()
		}
		w.Header().Set(RequestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, id)))
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

// AccessLog emits exactly one completion log per request, per rule 6 of the
// shared log schema. Handlers do not log requests themselves.
func AccessLog(logger zerolog.Logger, activeFlags func() string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Health probes every ten seconds would otherwise dominate the log
			// volume and tell you nothing.
			if r.URL.Path == "/health" || r.URL.Path == "/ready" {
				next.ServeHTTP(w, r)
				return
			}

			started := time.Now()
			wrapped := &statusWriter{ResponseWriter: w}
			next.ServeHTTP(wrapped, r)
			if wrapped.status == 0 {
				wrapped.status = http.StatusOK
			}

			event := logger.Info()
			if wrapped.status >= 500 {
				event = logger.Error()
			} else if wrapped.status >= 400 {
				event = logger.Warn()
			}

			event.
				Dict("http", zerolog.Dict().
					Str("method", r.Method).
					Dict("url_details", zerolog.Dict().Str("path", r.URL.Path)).
					Int("status_code", wrapped.status).
					Str("request_id", RequestID(r.Context()))).
				Int64("duration", time.Since(started).Nanoseconds()).
				Dict("chaos", zerolog.Dict().Str("active_flags", activeFlags())).
				Msg("Request completed")
		})
	}
}
