#!/usr/bin/env bash
#
# Drives one signed-in traveller through a complete checkout, plus a declined
# card, entirely through the gateway.
#
# This exists for verify-tracing.sh, which needs the booking and payment spans
# to actually happen and does not care whether any of it is correct --
# verify-booking.sh owns correctness, in 55 assertions. Keeping the two apart
# means the tracing check cannot start failing because a booking assertion
# moved.
#
# Two details are load-bearing rather than incidental:
#
#   Signed in, not a guest. usr.id is one of the twelve required span tags and
#   a guest booking has no user to put on it.
#
#   Through the gateway, not straight at the services. The gateway is what
#   starts the trace and forwards the context, so calling booking-service
#   directly would produce spans that are all local roots and prove nothing
#   about propagation.
#
# The declined card is not optional either: payment.decline_code only ever
# appears on a refused card.

set -uo pipefail

GATEWAY=${GATEWAY_URL:-http://127.0.0.1:4000}

field() { python3 -c "
import json, sys
doc = json.load(open(sys.argv[1]))
for key in sys.argv[2].split('.'):
    if isinstance(doc, list):
        doc = doc[int(key)] if key.isdigit() and int(key) < len(doc) else None
    elif isinstance(doc, dict):
        doc = doc.get(key)
    else:
        doc = None
print(doc if doc is not None else '')
" "$1" "$2" 2>/dev/null; }

out=/tmp/voyager-drive

# .test is a reserved TLD that email-validator refuses, which would fail the
# signup rather than anything this is here to exercise.
email="trace-$(date +%s%N)@example.com"
curl -sS -o "$out-signup.json" -X POST "$GATEWAY/api/v1/auth/signup" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"correct-horse-battery\",\"firstName\":\"Ada\",\"lastName\":\"Tracer\"}"

access=$(field "$out-signup.json" accessToken)
[[ -z $access ]] && exit 0

# A date nobody has searched for: a cache hit skips the fan-out entirely.
depart=$(date -v+"$((RANDOM % 180 + 30))"d +%Y-%m-%d 2>/dev/null \
      || date -d "+$((RANDOM % 180 + 30)) days" +%Y-%m-%d)

checkout() {
  local card=$1

  curl -sS -o "$out-search.json" -X POST "$GATEWAY/api/v1/search/flights" \
    -H 'content-type: application/json' -H "authorization: Bearer $access" \
    -d "{\"origin\":\"LHR\",\"destination\":\"JFK\",\"departDate\":\"$depart\",\"passengers\":{\"adults\":1,\"children\":0,\"infants\":0},\"cabin\":\"economy\"}"

  local search_id result_id
  search_id=$(field "$out-search.json" searchId)
  result_id=$(field "$out-search.json" results.0.id)
  [[ -z $result_id ]] && return 0

  curl -sS -o "$out-checkout.json" -X POST "$GATEWAY/api/v1/bff/checkout/init" \
    -H 'content-type: application/json' -H "authorization: Bearer $access" \
    -d "{\"searchId\":\"$search_id\",\"resultId\":\"$result_id\",\"contactEmail\":\"$email\",\"passengerCounts\":{\"adult\":1,\"child\":0,\"infant\":0}}"

  local booking_id
  booking_id=$(field "$out-checkout.json" booking.id)
  [[ -z $booking_id ]] && return 0

  curl -sS -o /dev/null -X PUT "$GATEWAY/api/v1/bookings/$booking_id/passengers" \
    -H 'content-type: application/json' -H "authorization: Bearer $access" \
    -d '{"passengers":[{"passengerType":"adult","title":"Ms","firstName":"Ada","lastName":"Tracer","dateOfBirth":"1990-04-12","nationality":"GB"}]}'

  curl -sS -o "$out-anc.json" -X PUT "$GATEWAY/api/v1/bookings/$booking_id/ancillaries" \
    -H 'content-type: application/json' -H "authorization: Bearer $access" \
    -d '{"ancillaries":[{"type":"baggage","description":"Checked bag, 23kg","quantity":1}]}'

  local total
  total=$(field "$out-anc.json" totalCents)
  [[ -z $total ]] && return 0

  local idem="trace-$(date +%s%N)-$RANDOM"
  curl -sS -o "$out-auth.json" -X POST "$GATEWAY/api/v1/payments/authorize" \
    -H 'content-type: application/json' -H "authorization: Bearer $access" \
    -H "Idempotency-Key: $idem" \
    -d "{\"bookingId\":\"$booking_id\",\"amountCents\":$total,\"currency\":\"GBP\",\"card\":{\"number\":\"$card\",\"expiryMonth\":12,\"expiryYear\":2029,\"cvc\":\"123\",\"holderName\":\"Ada Tracer\"}}"
}

# 4242… authorises; 4000000000009995 is refused for insufficient funds.
checkout 4242424242424242
checkout 4000000000009995

# booking.state_transition to CONFIRMED, loyalty's accrual and the itinerary
# render all happen on the Kafka side, after the HTTP call has returned.
sleep 8
