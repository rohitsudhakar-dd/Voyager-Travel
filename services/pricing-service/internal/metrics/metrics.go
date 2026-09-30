// Package metrics emits this service's DogStatsD business metrics
// (05-FUNCTIONALITY.md § 14).
//
// One file, like the tracer and the logger, so the whole DogStatsD integration
// is readable in one sitting. Every metric name and every tag key in the
// service is spelled once, here: a name spelled two ways is two metrics in
// Datadog and neither of them is complete.
//
// The client is datadog-go, which dd-trace-go already depends on, so this costs
// no new module. It reads DD_ENV, DD_SERVICE and DD_VERSION from the environment
// and appends them to every metric itself, which is why nothing below passes
// them as tags -- doing so would send each one twice. DD_TAGS is not its job:
// the Agent applies its own to everything it forwards.
package metrics

import (
	"net"
	"os"

	"github.com/DataDog/datadog-go/v5/statsd"
)

// The § 14 catalogue for pricing-service. A constant rather than a literal at
// the call site, because a typo in a metric name is invisible: the metric
// simply appears under the wrong name and every query for the right one
// returns nothing at all.
const RulesEvaluated = "voyager.pricing.rules_evaluated"

// A no-op until Start runs, so a metric emitted before or after the client
// exists is dropped rather than a nil dereference. Instrumentation must never
// be the thing that takes a service down.
var client statsd.ClientInterface = &statsd.NoOpClient{}

// Start opens the DogStatsD socket. The returned function flushes and closes
// it and must be deferred from main: UDP datagrams still sitting in the
// client's buffer at exit are simply lost.
func Start() func() {
	host := env("DD_DOGSTATSD_HOST", env("DD_AGENT_HOST", "localhost"))
	port := env("DD_DOGSTATSD_PORT", "8125")

	created, err := statsd.New(net.JoinHostPort(host, port))
	if err != nil {
		// Unreachable DogStatsD is not a startup failure. The metrics are
		// gone; the service still prices.
		return func() {}
	}
	client = created
	return func() {
		_ = client.Close()
		client = &statsd.NoOpClient{}
	}
}

// Distribution records one observation. A distribution rather than a histogram,
// as everywhere in § 14: percentiles are computed server-side across every
// container, so a p99 stays a p99 when the service is scaled out.
func Distribution(name string, value float64, tags ...string) {
	_ = client.Distribution(name, value, tags, 1)
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
