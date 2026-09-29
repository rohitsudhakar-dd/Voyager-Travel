// Package chaos reads the shared flag hash from Redis
// (05-FUNCTIONALITY.md § 10).
//
// Three rules it must obey: fail open, so an unreachable Redis never breaks a
// demo; no restarts, so a flag takes effect on the next request; and a
// 2-second cache, long enough not to hammer Redis and short enough that a
// toggle feels instant on stage.
package chaos

import (
	"context"
	"encoding/json"
	"math/rand"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	HashKey  = "voyager:chaos"
	cacheTTL = 2 * time.Second
)

type Reader struct {
	client *redis.Client

	mu       sync.RWMutex
	snapshot map[string]string
	loadedAt time.Time
	loading  bool
}

func New(client *redis.Client) *Reader {
	return &Reader{client: client, snapshot: map[string]string{}}
}

// Refresh reloads the snapshot if it is older than the cache TTL. Call it
// once at the start of a request.
func (r *Reader) Refresh(ctx context.Context) {
	if r.client == nil {
		return
	}

	r.mu.RLock()
	fresh := time.Since(r.loadedAt) < cacheTTL || r.loading
	r.mu.RUnlock()
	if fresh {
		return
	}

	r.mu.Lock()
	if r.loading {
		r.mu.Unlock()
		return
	}
	r.loading = true
	r.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	values, err := r.client.HGetAll(ctx, HashKey).Result()

	r.mu.Lock()
	if err == nil {
		r.snapshot = values
	} else {
		// Fail open. A Redis hiccup means no chaos, never an error.
		r.snapshot = map[string]string{}
	}
	r.loadedAt = time.Now()
	r.loading = false
	r.mu.Unlock()
}

func (r *Reader) raw(flag string) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	value, ok := r.snapshot[flag]
	return value, ok && value != ""
}

func (r *Reader) Bool(flag string) bool {
	value, ok := r.raw(flag)
	if !ok {
		return false
	}
	return value == "true" || value == "1" || value == `"true"`
}

func (r *Reader) Float(flag string, fallback float64) float64 {
	value, ok := r.raw(flag)
	if !ok {
		return fallback
	}
	parsed, err := strconv.ParseFloat(strings.Trim(value, `"`), 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func (r *Reader) Int(flag string, fallback int) int {
	return int(r.Float(flag, float64(fallback)))
}

func (r *Reader) String(flag, fallback string) string {
	value, ok := r.raw(flag)
	if !ok {
		return fallback
	}
	// Values are JSON-encoded scalars, but a bare value set by hand with
	// redis-cli should work too -- an operator mid-demo should not have to
	// remember to quote things.
	var unquoted string
	if err := json.Unmarshal([]byte(value), &unquoted); err == nil {
		return unquoted
	}
	return value
}

// ServiceFloat reads one entry from a service→value map flag, such as
// `service_error_rate`.
func (r *Reader) ServiceFloat(flag, service string, fallback float64) float64 {
	value, ok := r.raw(flag)
	if !ok {
		return fallback
	}
	var byService map[string]float64
	if err := json.Unmarshal([]byte(value), &byService); err != nil {
		return fallback
	}
	if found, ok := byService[service]; ok {
		return found
	}
	return fallback
}

// Delay sleeps for the configured number of milliseconds. Real waiting, not
// fake work: a slow dependency is a slow dependency.
func (r *Reader) Delay(ctx context.Context, flag string) time.Duration {
	milliseconds := r.Int(flag, 0)
	if milliseconds <= 0 {
		return 0
	}
	delay := time.Duration(milliseconds) * time.Millisecond
	select {
	case <-time.After(delay):
	case <-ctx.Done():
	}
	return delay
}

func (r *Reader) Fail(flag string) bool {
	rate := r.Float(flag, 0)
	return rate > 0 && rand.Float64() < rate
}

// ActiveFlags is the sorted list for the `chaos.active_flags` span tag and
// log field.
func (r *Reader) ActiveFlags() string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	active := make([]string, 0, len(r.snapshot))
	for flag, value := range r.snapshot {
		if value == "" || value == "false" || value == "0" {
			continue
		}
		active = append(active, flag)
	}
	sort.Strings(active)
	return strings.Join(active, ",")
}
