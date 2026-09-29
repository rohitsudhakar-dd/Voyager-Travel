#!/usr/bin/env bash
#
# Creates every topic in 05-FUNCTIONALITY.md § 6, then exits.
#
# Run as a Compose init job rather than left to auto-creation: an auto-created
# topic gets one partition, and the whole point of three is that partitioning
# by booking_id keeps a booking's events ordered while still spreading load.
set -euo pipefail

# The CLI tools are not on PATH in apache/kafka:3.8.1. Adding the directory
# rather than calling each script by full path keeps the commands below
# readable, and means a broken image fails on the first call instead of being
# swallowed by the readiness loop.
export PATH="${KAFKA_HOME:-/opt/kafka}/bin:$PATH"
command -v kafka-topics.sh >/dev/null || {
  echo "kafka-topics.sh not found under ${KAFKA_HOME:-/opt/kafka}/bin" >&2
  exit 1
}

BROKER=${KAFKA_BROKER:-kafka:9092}
PARTITIONS=${KAFKA_PARTITIONS:-3}
REPLICATION=${KAFKA_REPLICATION:-1}
RETENTION_MS=${KAFKA_RETENTION_MS:-604800000}   # 7 days

TOPICS=(
  voyager.bookings.events
  voyager.payments.events
  voyager.notifications.outbound
  voyager.notifications.dlq
  voyager.loyalty.accruals
  voyager.search.analytics
)

# Every CLI tool in this image inherits KAFKA_JMX_OPTS from the broker's own
# environment and then fails to bind the JMX port. Clearing it is the fix.
export KAFKA_JMX_OPTS=""

echo "waiting for ${BROKER}"
ready=no
for _ in $(seq 1 60); do
  if kafka-topics.sh --bootstrap-server "$BROKER" --list >/dev/null 2>&1; then
    ready=yes
    break
  fi
  sleep 2
done
[ "$ready" = yes ] || { echo "broker ${BROKER} never became reachable" >&2; exit 1; }

for topic in "${TOPICS[@]}"; do
  kafka-topics.sh --bootstrap-server "$BROKER" \
    --create --if-not-exists \
    --topic "$topic" \
    --partitions "$PARTITIONS" \
    --replication-factor "$REPLICATION" \
    --config "retention.ms=$RETENTION_MS" >/dev/null
  echo "  ready: $topic"
done

echo
kafka-topics.sh --bootstrap-server "$BROKER" --list
