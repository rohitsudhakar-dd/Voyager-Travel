// Package tracing starts and stops the Datadog tracer and the profiler.
//
// Go has no equivalent of `node --require` or `ddtrace-run`, so instrumentation
// is explicit: the tracer starts first in main, every client is wrapped at the
// point it is constructed, and the router carries the chi middleware. Anything
// built before Start, or built unwrapped, simply produces no spans -- with no
// error to say so, which is why each wrapper lives next to the thing it wraps
// rather than in a single setup function far away.
package tracing

import (
	"context"
	"os"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"gopkg.in/DataDog/dd-trace-go.v1/ddtrace/tracer"
	"gopkg.in/DataDog/dd-trace-go.v1/profiler"

	pgxtrace "gopkg.in/DataDog/dd-trace-go.v1/contrib/jackc/pgx.v5"
	redistrace "gopkg.in/DataDog/dd-trace-go.v1/contrib/redis/go-redis.v9"
)

// Start boots the tracer and, when DD_PROFILING_ENABLED is set, the profiler.
// The returned function stops both and must be deferred from main.
func Start(service, env, version string) func() {
	tracer.Start(
		tracer.WithService(service),
		tracer.WithEnv(env),
		tracer.WithServiceVersion(version),
		// Without this the tracer emits its own logs through the standard
		// logger in a format nothing else in this project uses, which makes
		// the container's output unparseable halfway down.
		tracer.WithLogStartup(false),
		// Source Code Integration. These are set at build time from the git
		// SHA; a stack frame in Error Tracking becomes a link to the line.
		tracer.WithGlobalTag("git.repository_url", os.Getenv("DD_GIT_REPOSITORY_URL")),
		tracer.WithGlobalTag("git.commit.sha", os.Getenv("DD_GIT_COMMIT_SHA")),
	)

	stopProfiler := func() {}
	if enabled, _ := strconv.ParseBool(os.Getenv("DD_PROFILING_ENABLED")); enabled {
		// The CPU and heap profiles are what Phase 10 needs; the others cost
		// overhead for signal this application never produces.
		err := profiler.Start(
			profiler.WithService(service),
			profiler.WithEnv(env),
			profiler.WithVersion(version),
			profiler.WithProfileTypes(profiler.CPUProfile, profiler.HeapProfile),
		)
		if err == nil {
			stopProfiler = profiler.Stop
		}
	}

	return func() {
		stopProfiler()
		tracer.Stop()
	}
}

// WrapRedis returns the client with tracing attached.
//
// The only Redis traffic here is the chaos reader's poll, which is not
// interesting in itself -- but leaving one client unwrapped is how a service
// ends up with a gap in the map that nobody can explain later.
func WrapRedis(client *redis.Client, service string) *redis.Client {
	redistrace.WrapClient(client, redistrace.WithServiceName(service+"-redis"))
	return client
}

// NewPool builds a traced pgx pool.
//
// The contrib owns pool construction rather than decorating an existing pool:
// the tracer hangs off the connection config, so a pool built by
// pgxpool.New and handed over afterwards produces no query spans at all.
//
// pricing-service holds the whole rule set in memory and refreshes it on a
// timer, so the Postgres traffic is a handful of large reads rather than a
// query per request. That makes each one worth seeing individually, which is
// what DBM needs to attribute the refresh cost.
func NewPool(ctx context.Context, cfg *pgxpool.Config, service string) (*pgxpool.Pool, error) {
	return pgxtrace.NewPoolWithConfig(ctx, cfg,
		pgxtrace.WithServiceName(service+"-postgres"),
		// Acquire spans are off by default. They are the only way to tell a
		// query that is slow from a query that spent its time waiting for a
		// free connection -- which is exactly what `db_pool_starvation` does.
		pgxtrace.WithTraceAcquire(true),
		pgxtrace.WithPoolStats(),
	)
}

// Span runs fn inside a named child span.
//
// The wrapper exists so the call sites stay one line: Go has no decorator, and
// the four-line StartSpanFromContext / defer Finish dance repeated at every
// interesting point buries the work it is meant to describe.
func Span(ctx context.Context, name string, fn func(ctx context.Context)) {
	span, ctx := tracer.StartSpanFromContext(ctx, name)
	defer span.Finish()
	fn(ctx)
}

// RootTag tags the request's local root span rather than whichever span
// happens to be current.
//
// A tag set on a leaf can only be found by someone who already knows which
// leaf to open. On the root it is a facet: "show me every trace where
// search.cache_hit is false" is the question this application exists to
// answer, and it only works if the tag is where the search looks.
func RootTag(ctx context.Context, key string, value any) {
	span, ok := tracer.SpanFromContext(ctx)
	if !ok {
		return
	}
	// A nil root happens when the span came from a context that outlived its
	// trace; tagging it would panic on a path that is otherwise harmless.
	if root, ok := span.(interface{ Root() tracer.Span }); ok && root.Root() != nil {
		root.Root().SetTag(key, value)
		return
	}
	span.SetTag(key, value)
}
