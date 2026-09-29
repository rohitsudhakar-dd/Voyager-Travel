// Package cache is the Redis layer behind search.
//
// Two keys per search: the request hash points at a search id, and the search
// id points at the full result set. Both carry the same TTL, so a set never
// outlives the pointer that finds it.
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"voyager/search-service/internal/chaos"
	"voyager/search-service/internal/store"
)

// DefaultTTL is the 120 s from 05-FUNCTIONALITY.md § 7 step 3. The
// `cache_ttl_seconds` flag overrides it; set it to 1 for near-constant
// misses.
const DefaultTTL = 120 * time.Second

var ErrMiss = errors.New("cache miss")

type Cache struct {
	client *redis.Client
	flags  *chaos.Reader
}

func New(client *redis.Client, flags *chaos.Reader) *Cache {
	return &Cache{client: client, flags: flags}
}

func (c *Cache) ttl() time.Duration {
	seconds := c.flags.Int("cache_ttl_seconds", int(DefaultTTL.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	return time.Duration(seconds) * time.Second
}

// disabled reports whether the cache should behave as if it were not there.
// Reads miss and writes are skipped -- the same shape as a cold cache, which
// is what makes the S4 cascade realistic rather than a special case.
func (c *Cache) disabled() bool {
	return c.flags.Bool("redis_disabled")
}

func (c *Cache) latency(ctx context.Context) {
	c.flags.Delay(ctx, "redis_latency_ms")
}

// LookupSearchID resolves a request hash to an existing search id.
func (c *Cache) LookupSearchID(ctx context.Context, key string) (string, error) {
	if c.disabled() {
		return "", ErrMiss
	}
	c.latency(ctx)

	searchID, err := c.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", ErrMiss
	}
	if err != nil {
		return "", err
	}
	return searchID, nil
}

// Load reads a full result set by search id.
func (c *Cache) Load(ctx context.Context, searchID string) (*store.ResultSet, error) {
	if c.disabled() {
		return nil, ErrMiss
	}
	c.latency(ctx)

	encoded, err := c.client.Get(ctx, store.ResultSetKey(searchID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrMiss
	}
	if err != nil {
		return nil, err
	}

	var set store.ResultSet
	if err := json.Unmarshal(encoded, &set); err != nil {
		// A set we cannot decode is worse than no set at all: drop it rather
		// than serving every future request a decode error.
		c.client.Del(ctx, store.ResultSetKey(searchID))
		return nil, ErrMiss
	}
	return &set, nil
}

// Store writes the result set and the hash pointer under one TTL.
func (c *Cache) Store(ctx context.Context, key string, set *store.ResultSet) error {
	if c.disabled() {
		return nil
	}
	c.latency(ctx)

	encoded, err := json.Marshal(set)
	if err != nil {
		return err
	}

	ttl := c.ttl()
	pipeline := c.client.TxPipeline()
	pipeline.Set(ctx, store.ResultSetKey(set.SearchID), encoded, ttl)
	pipeline.Set(ctx, key, set.SearchID, ttl)
	_, err = pipeline.Exec(ctx)
	return err
}

// TTLSeconds reports the TTL currently in force, for the response body.
func (c *Cache) TTLSeconds() int {
	return int(c.ttl().Seconds())
}
