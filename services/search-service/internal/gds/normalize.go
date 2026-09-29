package gds

import (
	"math"
	"strings"

	"voyager/search-service/internal/store"
)

// normalizeFlights maps one provider response, in whichever schema it
// arrived, into canonical results.
func normalizeFlights(response flightResponse) []store.FlightResult {
	if response.SchemaVersion == "trvp-legacy-v1" {
		return normalizeTrvp(response)
	}
	return normalizeV2(response)
}

func normalizeV2(response flightResponse) []store.FlightResult {
	results := make([]store.FlightResult, 0, len(response.Offers))
	for _, offer := range response.Offers {
		segments := make([]store.Segment, 0, len(offer.Segments))
		duration := 0
		for _, segment := range offer.Segments {
			duration += segment.DurationMinutes
			segments = append(segments, store.Segment{
				FlightID:        segment.FlightID,
				FlightNumber:    segment.FlightNumber,
				Origin:          segment.Origin,
				Destination:     segment.Destination,
				DepartureTime:   segment.DepartureTime.UTC(),
				ArrivalTime:     segment.ArrivalTime.UTC(),
				Aircraft:        segment.Aircraft,
				DurationMinutes: segment.DurationMinutes,
			})
		}

		results = append(results, store.FlightResult{
			ID:       store.ResultID("fr", offer.OfferID),
			Provider: response.Provider,
			OfferID:  offer.OfferID,
			Airline: store.Airline{
				Code: offer.MarketingCarrier.Code,
				Name: offer.MarketingCarrier.Name,
			},
			Segments: segments,
			Fare: store.Fare{
				Basis:            offer.Fare.Basis,
				Cabin:            offer.Fare.Cabin,
				BaseAmountCents:  offer.Fare.BaseAmountCents,
				TaxesCents:       offer.Fare.TaxAmountCents,
				TotalAmountCents: offer.Fare.TotalAmountCents,
				Currency:         offer.Fare.Currency,
				Refundable:       offer.Fare.Refundable,
				Changeable:       offer.Fare.Changeable,
				BaggageAllowance: offer.Fare.BaggageAllowance,
			},
			DurationMinutes: duration,
			Stops:           maxInt(0, len(segments)-1),
			SeatsRemaining:  offer.SeatsRemaining,
		})
	}
	return results
}

func normalizeTrvp(response flightResponse) []store.FlightResult {
	results := make([]store.FlightResult, 0, len(response.Results))
	for _, offer := range response.Results {
		segments := make([]store.Segment, 0, len(offer.Legs))
		duration := 0
		for _, leg := range offer.Legs {
			duration += leg.Mins
			segments = append(segments, store.Segment{
				FlightNumber:    leg.Flt,
				Origin:          leg.From,
				Destination:     leg.To,
				DepartureTime:   leg.Dep.UTC(),
				ArrivalTime:     leg.Arr.UTC(),
				Aircraft:        leg.Eqp,
				DurationMinutes: leg.Mins,
			})
		}

		// TRVP quotes a gross amount in major units. Rounding rather than
		// truncating matters: 412.50 must become 41250, not 41249.
		total := int64(math.Round(offer.Price.Amt * 100))

		results = append(results, store.FlightResult{
			ID:       store.ResultID("fr", offer.ID),
			Provider: response.Provider,
			OfferID:  offer.ID,
			Airline:  store.Airline{Code: offer.Carrier, Name: offer.Carrier},
			Segments: segments,
			Fare: store.Fare{
				Basis: offer.FareCode,
				Cabin: offer.CabinClass,
				// The legacy schema has no tax breakdown, only a gross
				// figure. Re-pricing fills the components in; until then the
				// gross amount is the only honest thing to report.
				BaseAmountCents:  total,
				TotalAmountCents: total,
				Currency:         offer.Price.Cur,
				Refundable:       isYes(offer.Refund),
				Changeable:       isYes(offer.Chg),
				BaggageAllowance: offer.Bags,
			},
			DurationMinutes: duration,
			Stops:           maxInt(0, len(segments)-1),
			SeatsRemaining:  offer.Seats,
		})
	}
	return results
}

func normalizeHotels(response hotelResponse) []store.HotelResult {
	results := make([]store.HotelResult, 0, len(response.Properties))
	for _, property := range response.Properties {
		rates := make([]store.HotelRate, 0, len(property.Rates))
		var lead int64 = math.MaxInt64
		currency := "GBP"
		for _, rate := range property.Rates {
			if rate.TotalCents < lead {
				lead = rate.TotalCents
				currency = rate.Currency
			}
			rates = append(rates, store.HotelRate(rate))
		}
		if lead == math.MaxInt64 {
			lead = 0
		}

		results = append(results, store.HotelResult{
			ID:           store.ResultID("hr", response.Provider+":"+property.PropertyID),
			Provider:     response.Provider,
			PropertyID:   property.PropertyID,
			Name:         property.Name,
			StarRating:   property.StarRating,
			ReviewScore:  property.ReviewScore,
			ReviewCount:  property.ReviewCount,
			Neighborhood: property.Neighborhood,
			Address:      property.Address,
			Latitude:     property.Latitude,
			Longitude:    property.Longitude,
			Amenities:    property.Amenities,
			ImageSeed:    property.ImageSeed,
			Rates:        rates,
			LeadCents:    lead,
			Currency:     currency,
		})
	}
	return results
}

// DedupeFlights collapses the same physical flight and fare offered by more
// than one provider down to the cheapest quote.
//
// All four providers read the same inventory, so without this every result
// appears four times. Real OTAs do exactly this, and it is what keeps the
// result count sane enough to price in a single batch.
func DedupeFlights(results []store.FlightResult) []store.FlightResult {
	seen := make(map[string]int, len(results))
	deduped := make([]store.FlightResult, 0, len(results))

	for _, result := range results {
		key := dedupeKey(result)
		if index, ok := seen[key]; ok {
			if result.Fare.TotalAmountCents < deduped[index].Fare.TotalAmountCents {
				deduped[index] = result
			}
			continue
		}
		seen[key] = len(deduped)
		deduped = append(deduped, result)
	}
	return deduped
}

func dedupeKey(result store.FlightResult) string {
	var builder strings.Builder
	for _, segment := range result.Segments {
		builder.WriteString(segment.FlightNumber)
		builder.WriteByte('@')
		builder.WriteString(segment.DepartureTime.Format("2006-01-02T15:04Z"))
		builder.WriteByte(';')
	}
	builder.WriteString(result.Fare.Basis)
	return builder.String()
}

// DedupeHotels keeps the cheapest quote per property.
func DedupeHotels(results []store.HotelResult) []store.HotelResult {
	seen := make(map[string]int, len(results))
	deduped := make([]store.HotelResult, 0, len(results))

	for _, result := range results {
		if index, ok := seen[result.PropertyID]; ok {
			if result.LeadCents < deduped[index].LeadCents {
				deduped[index] = result
			}
			continue
		}
		seen[result.PropertyID] = len(deduped)
		deduped = append(deduped, result)
	}
	return deduped
}

func isYes(value string) bool {
	return strings.EqualFold(value, "Y")
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
