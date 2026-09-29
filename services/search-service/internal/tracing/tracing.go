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
	"os"
	"strconv"

	"github.com/redis/go-redis/v9"
	"gopkg.in/DataDog/dd-trace-go.v1/ddtrace/tracer"
	"gopkg.in/DataDog/dd-trace-go.v1/profiler"

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
// Every Redis call in this service goes through the returned client. The chaos
// reader polls Redis twice a second, so leaving it untraced would be the
// difference between a cache lookup that appears in a trace and one that does
// not -- and the cache lookup is the point of the search demo.
func WrapRedis(client *redis.Client, service string) *redis.Client {
	redistrace.WrapClient(client, redistrace.WithServiceName(service+"-redis"))
	return client
}
