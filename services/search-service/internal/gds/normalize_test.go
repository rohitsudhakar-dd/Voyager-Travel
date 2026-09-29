package gds

import (
	"encoding/json"
	"testing"

	"voyager/search-service/internal/store"
)

// Captured from a live mock-gds response so the test breaks if the wire
// format drifts.
const v2Payload = `{
  "provider": "AMDS",
  "requestId": "60548695-fa03-4b99-b8c8-f57e5fd813a5",
  "schemaVersion": "v2",
  "offers": [{
    "offerId": "AMDS-5881-ECOFLEX",
    "marketingCarrier": { "code": "ZP", "name": "Zephyr Pacific" },
    "segments": [{
      "flightId": "5881",
      "flightNumber": "ZP6881",
      "origin": "LHR",
      "destination": "JFK",
      "departureTime": "2026-10-13T06:18:00.000Z",
      "arrivalTime": "2026-10-13T13:38:00.000Z",
      "aircraft": "Corvus 700",
      "durationMinutes": 440
    }],
    "fare": {
      "basis": "ECOFLEX", "cabin": "economy",
      "baseAmountCents": 24523, "taxAmountCents": 2698,
      "totalAmountCents": 27221, "currency": "GBP",
      "refundable": true, "changeable": true, "baggageAllowance": 2
    },
    "seatsRemaining": 74
  }]
}`

const trvpPayload = `{
  "provider": "TRVP",
  "requestId": "9d2c1f80-1111-4a2b-9f31-0c1d2e3f4a5b",
  "schemaVersion": "trvp-legacy-v1",
  "results": [{
    "id": "TRVP-5881-ECOSTD",
    "carrier": "ZP",
    "legs": [{
      "flt": "ZP6881", "from": "LHR", "to": "JFK",
      "dep": "2026-10-13T06:18:00.000Z", "arr": "2026-10-13T13:38:00.000Z",
      "mins": 440, "eqp": "Corvus 700"
    }],
    "price": { "amt": 412.50, "cur": "GBP" },
    "cabinClass": "economy", "fareCode": "ECOSTD",
    "refund": "N", "chg": "Y", "bags": 1, "seats": 74
  }]
}`

func decode(t *testing.T, payload string) flightResponse {
	t.Helper()
	var response flightResponse
	if err := json.Unmarshal([]byte(payload), &response); err != nil {
		t.Fatalf("payload did not decode: %v", err)
	}
	return response
}

func TestV2SchemaMapsToCanonical(t *testing.T) {
	results := normalizeFlights(decode(t, v2Payload))

	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	result := results[0]

	if result.Airline.Code != "ZP" || result.Airline.Name != "Zephyr Pacific" {
		t.Errorf("airline = %+v", result.Airline)
	}
	if result.Fare.TotalAmountCents != 27221 {
		t.Errorf("total = %d, want 27221", result.Fare.TotalAmountCents)
	}
	if result.Stops != 0 {
		t.Errorf("stops = %d, want 0 for a single segment", result.Stops)
	}
	if result.DurationMinutes != 440 {
		t.Errorf("duration = %d, want 440", result.DurationMinutes)
	}
	if result.OfferID != "AMDS-5881-ECOFLEX" {
		t.Errorf("offerId must survive normalisation, got %q", result.OfferID)
	}
}

// The field that breaks naive mappers: TRVP quotes major units, everything
// else in Voyager is cents.
func TestTrvpMajorUnitsBecomeCents(t *testing.T) {
	results := normalizeFlights(decode(t, trvpPayload))

	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if got := results[0].Fare.TotalAmountCents; got != 41250 {
		t.Fatalf("412.50 should map to 41250 cents, got %d", got)
	}
}

func TestTrvpYesNoFlagsBecomeBooleans(t *testing.T) {
	result := normalizeFlights(decode(t, trvpPayload))[0]

	if result.Fare.Refundable {
		t.Error(`refund "N" must map to false`)
	}
	if !result.Fare.Changeable {
		t.Error(`chg "Y" must map to true`)
	}
}

// Rounding, not truncation. 412.50 * 100 is 41249.999... in binary floating
// point, so truncating loses a penny on a large fraction of fares.
func TestTrvpPriceConversionRounds(t *testing.T) {
	cases := map[float64]int64{
		412.50:  41250,
		1029.30: 102930,
		0.07:    7,
		99.99:   9999,
	}
	for amount, want := range cases {
		payload := trvpOffer{}
		payload.Price.Amt = amount
		payload.Price.Cur = "GBP"
		payload.ID = "TRVP-1-ECOSTD"

		results := normalizeTrvp(flightResponse{
			Provider:      "TRVP",
			SchemaVersion: "trvp-legacy-v1",
			Results:       []trvpOffer{payload},
		})
		if got := results[0].Fare.TotalAmountCents; got != want {
			t.Errorf("%.2f mapped to %d cents, want %d", amount, got, want)
		}
	}
}

// Both schemas must produce the same shape, or downstream code has to know
// which provider it came from -- which defeats the point of normalising.
func TestBothSchemasProduceTheSameShape(t *testing.T) {
	v2 := normalizeFlights(decode(t, v2Payload))[0]
	trvp := normalizeFlights(decode(t, trvpPayload))[0]

	if v2.Segments[0].FlightNumber != trvp.Segments[0].FlightNumber {
		t.Errorf("flight number differs: %q vs %q",
			v2.Segments[0].FlightNumber, trvp.Segments[0].FlightNumber)
	}
	if !v2.Segments[0].DepartureTime.Equal(trvp.Segments[0].DepartureTime) {
		t.Errorf("departure time differs: %v vs %v",
			v2.Segments[0].DepartureTime, trvp.Segments[0].DepartureTime)
	}
	if v2.DurationMinutes != trvp.DurationMinutes {
		t.Errorf("duration differs: %d vs %d", v2.DurationMinutes, trvp.DurationMinutes)
	}
	if v2.Fare.Cabin != trvp.Fare.Cabin {
		t.Errorf("cabin differs: %q vs %q", v2.Fare.Cabin, trvp.Fare.Cabin)
	}
}

func TestResultIDsAreStableAndProviderScoped(t *testing.T) {
	first := normalizeFlights(decode(t, v2Payload))[0].ID
	second := normalizeFlights(decode(t, v2Payload))[0].ID
	if first != second {
		t.Fatalf("the same offer produced two ids: %q and %q", first, second)
	}
	if first[:3] != "fr_" {
		t.Fatalf("flight result id should be prefixed fr_, got %q", first)
	}

	trvpID := normalizeFlights(decode(t, trvpPayload))[0].ID
	if trvpID == first {
		t.Fatal("offers from different providers must not share an id")
	}
}

// Every provider reads the same inventory, so without dedupe each flight
// appears four times.
func TestDedupeKeepsTheCheapestQuotePerFlightAndFare(t *testing.T) {
	segment := store.Segment{
		FlightNumber:  "ZP6881",
		DepartureTime: decode(t, v2Payload).Offers[0].Segments[0].DepartureTime,
	}
	build := func(provider string, total int64) store.FlightResult {
		return store.FlightResult{
			ID:       store.ResultID("fr", provider+"-5881-ECOSTD"),
			Provider: provider,
			Segments: []store.Segment{segment},
			Fare:     store.Fare{Basis: "ECOSTD", TotalAmountCents: total},
		}
	}

	deduped := DedupeFlights([]store.FlightResult{
		build("AMDS", 27221),
		build("SABR", 26000),
		build("TRVP", 29000),
		build("DRCT", 31000),
	})

	if len(deduped) != 1 {
		t.Fatalf("expected 1 deduped result, got %d", len(deduped))
	}
	if deduped[0].Provider != "SABR" {
		t.Errorf("expected the cheapest provider SABR, got %s", deduped[0].Provider)
	}
	if deduped[0].Fare.TotalAmountCents != 26000 {
		t.Errorf("total = %d, want 26000", deduped[0].Fare.TotalAmountCents)
	}
}

// A different fare basis on the same flight is a genuinely different product.
func TestDedupeKeepsDistinctFareBases(t *testing.T) {
	segment := store.Segment{FlightNumber: "ZP6881"}
	build := func(basis string) store.FlightResult {
		return store.FlightResult{
			Provider: "AMDS",
			Segments: []store.Segment{segment},
			Fare:     store.Fare{Basis: basis, TotalAmountCents: 20000},
		}
	}

	deduped := DedupeFlights([]store.FlightResult{
		build("ECOLITE"), build("ECOSTD"), build("ECOFLEX"),
	})
	if len(deduped) != 3 {
		t.Fatalf("expected 3 fare bases to survive dedupe, got %d", len(deduped))
	}
}

func TestHotelNormalisationPicksTheLeadRate(t *testing.T) {
	response := hotelResponse{
		Provider: "SABR",
		Properties: []v2Property{{
			PropertyID: "1383",
			Name:       "Belmont Court Old Town Apartments",
			StarRating: 5,
			Rates: []v2Rate{
				{RatePlanID: "1", TotalCents: 48000, Currency: "GBP"},
				{RatePlanID: "2", TotalCents: 31500, Currency: "GBP"},
				{RatePlanID: "3", TotalCents: 62000, Currency: "GBP"},
			},
		}},
	}

	results := normalizeHotels(response)
	if len(results) != 1 {
		t.Fatalf("expected 1 property, got %d", len(results))
	}
	if results[0].LeadCents != 31500 {
		t.Errorf("lead price = %d, want the cheapest rate 31500", results[0].LeadCents)
	}
	if len(results[0].Rates) != 3 {
		t.Errorf("all rates should survive, got %d", len(results[0].Rates))
	}
}

func TestHotelWithNoRatesDoesNotReportAnAbsurdLeadPrice(t *testing.T) {
	results := normalizeHotels(hotelResponse{
		Provider:   "SABR",
		Properties: []v2Property{{PropertyID: "1", Name: "Empty"}},
	})
	if results[0].LeadCents != 0 {
		t.Fatalf("lead price = %d, want 0 when there are no rates", results[0].LeadCents)
	}
}
