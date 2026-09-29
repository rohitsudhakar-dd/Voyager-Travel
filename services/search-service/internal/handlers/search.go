package handlers

import (
	"context"
	"errors"
	"time"

	"github.com/rs/zerolog"

	"voyager/search-service/internal/apierr"
	"voyager/search-service/internal/gds"
	"voyager/search-service/internal/pricing"
	"voyager/search-service/internal/store"
	"voyager/search-service/internal/tracing"
)

// Outcome is everything a handler needs to answer a search request.
type Outcome struct {
	Set      *store.ResultSet
	CacheHit bool
}

// runFlightSearch is the flow in 05-FUNCTIONALITY.md § 7: normalise, look in
// the cache, fan out on a miss, map every provider schema into one, price the
// batch, sort, store, return.
func (s *Server) runFlightSearch(ctx context.Context, criteria store.Criteria) (*Outcome, *apierr.Error) {
	key := store.CacheKey(criteria)

	if set, hit := s.lookupCache(ctx, key); hit {
		return &Outcome{Set: set, CacheHit: true}, nil
	}

	query := gds.FlightQuery{
		Origin:      criteria.Origin,
		Destination: criteria.Destination,
		DepartDate:  criteria.DepartDate,
		ReturnDate:  criteria.ReturnDate,
		Cabin:       criteria.Cabin,
	}
	query.Passengers.Adults = criteria.Adults
	query.Passengers.Children = criteria.Children
	query.Passengers.Infants = criteria.Infants

	var outcomes []gds.ProviderOutcome
	tracing.Span(ctx, "search.fanout", func(ctx context.Context) {
		outcomes = s.gds.FanOutFlights(ctx, query)
	})

	var raw []store.FlightResult
	responded := 0
	for _, outcome := range outcomes {
		if outcome.Err != nil {
			s.log.Warn().
				Str("gds_provider", outcome.Provider).
				Int64("duration", outcome.Duration.Nanoseconds()).
				Dict("error", zerolog.Dict().
					Str("kind", "GdsUnavailableError").
					Str("message", outcome.Err.Error())).
				Msg("Provider did not answer")
			continue
		}
		responded++
		raw = append(raw, outcome.Flights...)
	}

	// Partial results are fine; no results at all are not.
	if responded == 0 {
		return nil, apierr.GdsUnavailable(errors.New("every provider failed"))
	}

	// Four provider schemas collapsing into one is where a search spends its
	// CPU on a large result set, and it is invisible in the fan-out span
	// because it happens after every provider has answered.
	var results []store.FlightResult
	tracing.Span(ctx, "search.normalize_results", func(context.Context) {
		results = gds.DedupeFlights(raw)
		results = store.FilterFlights(results, criteria.Filters)

		// One batch, so the pricing call stays a single span with a bounded
		// payload. Beyond this the extra results would never be looked at.
		if len(results) > pricing.MaxBatchSize {
			store.SortFlights(results, store.DefaultSort)
			results = results[:pricing.MaxBatchSize]
		}
	})

	if err := s.priceFlights(ctx, criteria, results); err != nil {
		return nil, err
	}

	store.SortFlights(results, criteria.Sort)

	set := &store.ResultSet{
		SearchID:           store.NewSearchID(),
		ProductType:        store.Flights,
		Criteria:           criteria,
		CreatedAt:          time.Now().UTC(),
		ProvidersQueried:   len(gds.Providers),
		ProvidersResponded: responded,
		Flights:            results,
	}

	s.persist(ctx, key, set)
	return &Outcome{Set: set}, nil
}

func (s *Server) runHotelSearch(ctx context.Context, criteria store.Criteria) (*Outcome, *apierr.Error) {
	key := store.CacheKey(criteria)

	if set, hit := s.lookupCache(ctx, key); hit {
		return &Outcome{Set: set, CacheHit: true}, nil
	}

	var outcomes []gds.ProviderOutcome
	tracing.Span(ctx, "search.fanout", func(ctx context.Context) {
		outcomes = s.gds.FanOutHotels(ctx, gds.HotelQuery{
			City:     criteria.City,
			CheckIn:  criteria.CheckIn,
			CheckOut: criteria.CheckOut,
			Guests:   criteria.Adults + criteria.Children,
			Rooms:    criteria.Rooms,
		})
	})

	var raw []store.HotelResult
	responded := 0
	for _, outcome := range outcomes {
		if outcome.Err != nil {
			s.log.Warn().
				Str("gds_provider", outcome.Provider).
				Int64("duration", outcome.Duration.Nanoseconds()).
				Dict("error", zerolog.Dict().
					Str("kind", "GdsUnavailableError").
					Str("message", outcome.Err.Error())).
				Msg("Provider did not answer")
			continue
		}
		responded++
		raw = append(raw, outcome.Hotels...)
	}

	if responded == 0 {
		return nil, apierr.GdsUnavailable(errors.New("every provider failed"))
	}

	var results []store.HotelResult
	tracing.Span(ctx, "search.normalize_results", func(context.Context) {
		results = store.FilterHotels(gds.DedupeHotels(raw), criteria.Filters)
		store.SortHotels(results, criteria.Sort)
	})

	set := &store.ResultSet{
		SearchID:           store.NewSearchID(),
		ProductType:        store.Hotels,
		Criteria:           criteria,
		CreatedAt:          time.Now().UTC(),
		ProvidersQueried:   len(gds.Providers),
		ProvidersResponded: responded,
		Hotels:             results,
	}

	s.persist(ctx, key, set)
	return &Outcome{Set: set}, nil
}

// priceFlights replaces the provider's own numbers with pricing-service's.
// The results are mutated in place.
func (s *Server) priceFlights(ctx context.Context, criteria store.Criteria, results []store.FlightResult) *apierr.Error {
	if len(results) == 0 {
		return nil
	}

	offers := make([]pricing.Offer, 0, len(results))
	for _, result := range results {
		offer := pricing.Offer{
			ID:          result.ID,
			ProductType: string(store.Flights),
			Origin:      criteria.Origin,
			Destination: criteria.Destination,
			DepartDate:  criteria.DepartDate,
			FareClass:   result.Fare.Basis,
			Cabin:       result.Fare.Cabin,
			BaseCents:   result.Fare.BaseAmountCents,
			Currency:    result.Fare.Currency,
		}
		if criteria.ReturnDate != "" {
			returnDate := criteria.ReturnDate
			offer.ReturnDate = &returnDate
		}
		offers = append(offers, offer)
	}

	quotes, err := s.pricing.Batch(ctx, offers)
	if err != nil {
		return apierr.PricingUnavailable(err)
	}

	for index := range results {
		quote, ok := quotes[results[index].ID]
		if !ok {
			continue
		}
		results[index].Fare.BaseAmountCents = quote.BaseCents
		results[index].Fare.AdjustmentsCents = quote.AdjustmentsCents
		results[index].Fare.TaxesCents = quote.TaxesCents
		results[index].Fare.TotalAmountCents = quote.TotalCents
		results[index].Fare.AppliedRules = toAppliedRules(quote.AppliedRules)
	}
	return nil
}

func toAppliedRules(rules []pricing.AppliedRule) []store.AppliedRule {
	if len(rules) == 0 {
		return nil
	}
	converted := make([]store.AppliedRule, len(rules))
	for i, rule := range rules {
		converted[i] = store.AppliedRule(rule)
	}
	return converted
}

// lookupCache is loadCached in a span, with the outcome promoted to the root.
//
// A cache hit and a cache miss are the same request to everything except the
// latency, so search.cache_hit on the root span is the only way to compare
// the two populations without opening traces one at a time.
func (s *Server) lookupCache(ctx context.Context, key string) (*store.ResultSet, bool) {
	var set *store.ResultSet
	var hit bool
	tracing.Span(ctx, "search.cache_lookup", func(ctx context.Context) {
		set, hit = s.loadCached(ctx, key)
	})
	tracing.RootTag(ctx, "search.cache_hit", hit)
	return set, hit
}

// loadCached resolves a request hash all the way to a result set. A pointer
// that survived its set is treated as a miss rather than an error.
func (s *Server) loadCached(ctx context.Context, key string) (*store.ResultSet, bool) {
	searchID, err := s.cache.LookupSearchID(ctx, key)
	if err != nil {
		return nil, false
	}
	set, err := s.cache.Load(ctx, searchID)
	if err != nil {
		return nil, false
	}
	return set, true
}

// persist is best-effort. A cache write that fails costs the next caller a
// slow search; it must never fail the search in hand.
func (s *Server) persist(ctx context.Context, key string, set *store.ResultSet) {
	if err := s.cache.Store(ctx, key, set); err != nil {
		s.log.Warn().
			Str("search_id", set.SearchID).
			Dict("error", zerolog.Dict().
				Str("kind", "CacheError").
				Str("message", err.Error())).
			Msg("Result set was not cached")
	}
}
