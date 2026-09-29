// Package handlers serves the search HTTP surface.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	chitrace "gopkg.in/DataDog/dd-trace-go.v1/contrib/go-chi/chi.v5"

	"voyager/search-service/internal/apierr"
	"voyager/search-service/internal/cache"
	"voyager/search-service/internal/chaos"
	"voyager/search-service/internal/config"
	"voyager/search-service/internal/gds"
	"voyager/search-service/internal/httpx"
	"voyager/search-service/internal/pricing"
	"voyager/search-service/internal/store"
	"voyager/search-service/internal/tracing"
)

// The seed covers today plus 360 days (05-FUNCTIONALITY.md § 15); searching
// beyond it returns nothing, so say so rather than showing an empty page.
const maxSearchWindowDays = 360

type Server struct {
	cfg     config.Config
	log     zerolog.Logger
	cache   *cache.Cache
	gds     *gds.Client
	pricing *pricing.Client
	chaos   *chaos.Reader
	redis   *redis.Client
	router  chi.Router
}

func NewServer(
	cfg config.Config,
	log zerolog.Logger,
	flags *chaos.Reader,
	rdb *redis.Client,
) *Server {
	s := &Server{
		cfg:     cfg,
		log:     log,
		cache:   cache.New(rdb, flags),
		gds:     gds.NewClient(cfg.GdsBaseURL),
		pricing: pricing.NewClient(cfg.PricingBaseURL),
		chaos:   flags,
		redis:   rdb,
	}

	router := chi.NewRouter()
	// Before WithRequestID, so the request id the access log prints is the
	// one that lands on the span rather than the other way round.
	router.Use(chitrace.Middleware(chitrace.WithServiceName(cfg.Service)))
	router.Use(httpx.WithRequestID)
	router.Use(httpx.AccessLog(log, flags.ActiveFlags))

	router.Get("/health", s.health)
	router.Get("/ready", s.ready)
	router.Post("/v1/search/flights", s.searchFlights)
	router.Post("/v1/search/hotels", s.searchHotels)
	router.Get("/v1/search/{searchId}/results", s.results)
	router.Get("/v1/search/{searchId}/results/{resultId}", s.resultDetail)

	s.router = router
	return s
}

func (s *Server) Handler() http.Handler { return s.router }

// ---------------------------------------------------------------- health --

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"service": s.cfg.Service,
		"version": s.cfg.Version,
	})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.ReadinessTimeout)
	defer cancel()

	checks := map[string]string{"redis": "ok", "pricing": "ok"}
	if err := s.redis.Ping(ctx).Err(); err != nil {
		checks["redis"] = "error: " + err.Error()
	}
	if err := s.pricing.Ping(ctx); err != nil {
		checks["pricing"] = "error: " + err.Error()
	}

	status, state := http.StatusOK, "ready"
	for _, value := range checks {
		if value != "ok" {
			status, state = http.StatusServiceUnavailable, "not_ready"
		}
	}
	writeJSON(w, status, map[string]any{"status": state, "checks": checks})
}

// ---------------------------------------------------------------- search --

type flightRequest struct {
	Origin      string `json:"origin"`
	Destination string `json:"destination"`
	DepartDate  string `json:"departDate"`
	ReturnDate  string `json:"returnDate"`
	Passengers  struct {
		Adults   int `json:"adults"`
		Children int `json:"children"`
		Infants  int `json:"infants"`
	} `json:"passengers"`
	Cabin   string        `json:"cabin"`
	Sort    string        `json:"sort"`
	Filters store.Filters `json:"filters"`
}

type hotelRequest struct {
	City     string        `json:"city"`
	CheckIn  string        `json:"checkIn"`
	CheckOut string        `json:"checkOut"`
	Guests   int           `json:"guests"`
	Rooms    int           `json:"rooms"`
	Sort     string        `json:"sort"`
	Filters  store.Filters `json:"filters"`
}

// tagSearch puts the criteria on the root span.
//
// Route and cabin are flight concepts, so a hotel search leaves them unset
// rather than blank: "group by search.route" is only useful if every trace it
// returns actually has a route, and an empty bucket the size of the hotel
// traffic would drown the routes that matter. product.type is the facet that
// separates the two.
func tagSearch(ctx context.Context, criteria store.Criteria, flags string) {
	tracing.RootTag(ctx, "product.type", string(criteria.ProductType))
	tracing.RootTag(ctx, "chaos.active_flags", flags)

	if criteria.ProductType == store.Flights {
		tracing.RootTag(ctx, "search.route", criteria.Origin+"-"+criteria.Destination)
		tracing.RootTag(ctx, "search.cabin", criteria.Cabin)
	}
}

func (s *Server) searchFlights(w http.ResponseWriter, r *http.Request) {
	var request flightRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		s.fail(w, r, apierr.InvalidSearchCriteria("Request body is not valid JSON."))
		return
	}
	s.chaos.Refresh(r.Context())

	criteria, failure := normalizeFlightRequest(request)
	if failure != nil {
		s.fail(w, r, failure)
		return
	}

	tagSearch(r.Context(), criteria, s.chaos.ActiveFlags())

	outcome, failure := s.runFlightSearch(r.Context(), criteria)
	if failure != nil {
		s.fail(w, r, failure)
		return
	}

	start, end := store.Page(len(outcome.Set.Flights), 1, defaultPageSize)
	s.logSearch(r, outcome, criteria)
	writeJSON(w, http.StatusOK, map[string]any{
		"searchId":           outcome.Set.SearchID,
		"cacheHit":           outcome.CacheHit,
		"providersQueried":   outcome.Set.ProvidersQueried,
		"providersResponded": outcome.Set.ProvidersResponded,
		"resultCount":        len(outcome.Set.Flights),
		"results":            outcome.Set.Flights[start:end],
		"ttlSeconds":         s.cache.TTLSeconds(),
		"requestId":          httpx.RequestID(r.Context()),
	})
}

func (s *Server) searchHotels(w http.ResponseWriter, r *http.Request) {
	var request hotelRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		s.fail(w, r, apierr.InvalidSearchCriteria("Request body is not valid JSON."))
		return
	}
	s.chaos.Refresh(r.Context())

	criteria, failure := normalizeHotelRequest(request)
	if failure != nil {
		s.fail(w, r, failure)
		return
	}

	tagSearch(r.Context(), criteria, s.chaos.ActiveFlags())

	outcome, failure := s.runHotelSearch(r.Context(), criteria)
	if failure != nil {
		s.fail(w, r, failure)
		return
	}

	start, end := store.Page(len(outcome.Set.Hotels), 1, defaultPageSize)
	s.logSearch(r, outcome, criteria)
	writeJSON(w, http.StatusOK, map[string]any{
		"searchId":           outcome.Set.SearchID,
		"cacheHit":           outcome.CacheHit,
		"providersQueried":   outcome.Set.ProvidersQueried,
		"providersResponded": outcome.Set.ProvidersResponded,
		"resultCount":        len(outcome.Set.Hotels),
		"results":            outcome.Set.Hotels[start:end],
		"ttlSeconds":         s.cache.TTLSeconds(),
		"requestId":          httpx.RequestID(r.Context()),
	})
}

const defaultPageSize = 20

func (s *Server) results(w http.ResponseWriter, r *http.Request) {
	s.chaos.Refresh(r.Context())
	searchID := chi.URLParam(r, "searchId")

	set, err := s.cache.Load(r.Context(), searchID)
	if err != nil {
		s.fail(w, r, apierr.SearchResultExpired(searchID))
		return
	}

	page := queryInt(r, "page", 1)
	size := queryInt(r, "size", defaultPageSize)
	order := r.URL.Query().Get("sort")
	if order == "" {
		order = set.Criteria.Sort
	}

	body := map[string]any{
		"searchId":    set.SearchID,
		"productType": set.ProductType,
		"page":        page,
		"size":        size,
		"sort":        order,
		"requestId":   httpx.RequestID(r.Context()),
	}

	if set.ProductType == store.Hotels {
		store.SortHotels(set.Hotels, order)
		start, end := store.Page(len(set.Hotels), page, size)
		body["resultCount"] = len(set.Hotels)
		body["results"] = set.Hotels[start:end]
	} else {
		store.SortFlights(set.Flights, order)
		start, end := store.Page(len(set.Flights), page, size)
		body["resultCount"] = len(set.Flights)
		body["results"] = set.Flights[start:end]
	}

	writeJSON(w, http.StatusOK, body)
}

func (s *Server) resultDetail(w http.ResponseWriter, r *http.Request) {
	s.chaos.Refresh(r.Context())
	searchID := chi.URLParam(r, "searchId")
	resultID := chi.URLParam(r, "resultId")

	set, err := s.cache.Load(r.Context(), searchID)
	if err != nil {
		s.fail(w, r, apierr.SearchResultExpired(searchID))
		return
	}

	if set.ProductType == store.Hotels {
		for _, hotel := range set.Hotels {
			if hotel.ID == resultID {
				writeJSON(w, http.StatusOK, map[string]any{
					"searchId":  set.SearchID,
					"result":    hotel,
					"requestId": httpx.RequestID(r.Context()),
				})
				return
			}
		}
		s.fail(w, r, apierr.ResultNotFound(resultID))
		return
	}

	for _, flight := range set.Flights {
		if flight.ID != resultID {
			continue
		}

		body := map[string]any{
			"searchId":           set.SearchID,
			"result":             flight,
			"cancellationPolicy": cancellationPolicy(flight),
			"requestId":          httpx.RequestID(r.Context()),
		}

		// Seat availability is a live question, so it is fetched rather than
		// cached. A provider that will not answer must not cost the traveller
		// the rest of the page.
		if len(flight.Segments) > 0 && flight.Segments[0].FlightID != "" {
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			seatmap, err := s.gds.Seatmap(ctx, flight.Provider, flight.Segments[0].FlightID)
			cancel()
			if err == nil {
				body["seatmap"] = seatmap
			} else {
				body["seatmap"] = nil
			}
		}

		writeJSON(w, http.StatusOK, body)
		return
	}

	s.fail(w, r, apierr.ResultNotFound(resultID))
}

// --------------------------------------------------------- normalisation --

func normalizeFlightRequest(request flightRequest) (store.Criteria, *apierr.Error) {
	criteria := store.Criteria{
		ProductType: store.Flights,
		Origin:      strings.ToUpper(strings.TrimSpace(request.Origin)),
		Destination: strings.ToUpper(strings.TrimSpace(request.Destination)),
		DepartDate:  strings.TrimSpace(request.DepartDate),
		ReturnDate:  strings.TrimSpace(request.ReturnDate),
		Adults:      request.Passengers.Adults,
		Children:    request.Passengers.Children,
		Infants:     request.Passengers.Infants,
		Cabin:       strings.ToLower(strings.TrimSpace(request.Cabin)),
		Sort:        sortOrDefault(request.Sort),
		Filters:     request.Filters,
	}

	if len(criteria.Origin) != 3 || len(criteria.Destination) != 3 {
		return criteria, apierr.InvalidSearchCriteria(
			"origin and destination must be three-letter airport codes.")
	}
	if criteria.Origin == criteria.Destination {
		return criteria, apierr.InvalidSearchCriteria(
			"origin and destination must be different.")
	}
	if criteria.Adults < 1 {
		criteria.Adults = 1
	}
	if criteria.Cabin == "" {
		criteria.Cabin = "economy"
	}

	departure, failure := parseSearchDate(criteria.DepartDate, "departDate")
	if failure != nil {
		return criteria, failure
	}
	if criteria.ReturnDate != "" {
		returning, failure := parseSearchDate(criteria.ReturnDate, "returnDate")
		if failure != nil {
			return criteria, failure
		}
		if returning.Before(departure) {
			return criteria, apierr.InvalidSearchCriteria(
				"returnDate cannot be before departDate.")
		}
	}
	return criteria, nil
}

func normalizeHotelRequest(request hotelRequest) (store.Criteria, *apierr.Error) {
	criteria := store.Criteria{
		ProductType: store.Hotels,
		City:        strings.TrimSpace(request.City),
		CheckIn:     strings.TrimSpace(request.CheckIn),
		CheckOut:    strings.TrimSpace(request.CheckOut),
		Adults:      request.Guests,
		Rooms:       request.Rooms,
		Sort:        sortOrDefault(request.Sort),
		Filters:     request.Filters,
	}

	if criteria.City == "" {
		return criteria, apierr.InvalidSearchCriteria("city is required.")
	}
	if criteria.Adults < 1 {
		criteria.Adults = 2
	}
	if criteria.Rooms < 1 {
		criteria.Rooms = 1
	}

	checkIn, failure := parseSearchDate(criteria.CheckIn, "checkIn")
	if failure != nil {
		return criteria, failure
	}
	checkOut, failure := parseSearchDate(criteria.CheckOut, "checkOut")
	if failure != nil {
		return criteria, failure
	}
	if !checkOut.After(checkIn) {
		return criteria, apierr.InvalidSearchCriteria(
			"checkOut must be after checkIn.")
	}
	return criteria, nil
}

func parseSearchDate(value, field string) (time.Time, *apierr.Error) {
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return time.Time{}, apierr.InvalidSearchCriteria(field + " must be YYYY-MM-DD.")
	}

	today := time.Now().UTC().Truncate(24 * time.Hour)
	if parsed.Before(today) {
		return parsed, apierr.InvalidSearchCriteria(field + " cannot be in the past.")
	}
	if parsed.After(today.AddDate(0, 0, maxSearchWindowDays)) {
		return parsed, apierr.InvalidSearchCriteria(
			"We only sell travel up to 360 days ahead.")
	}
	return parsed, nil
}

func sortOrDefault(order string) string {
	if order == "" {
		return store.DefaultSort
	}
	return order
}

// ----------------------------------------------------------------- utils --

func cancellationPolicy(flight store.FlightResult) map[string]any {
	if flight.Fare.Refundable {
		return map[string]any{
			"refundable":     true,
			"freeUntilHours": 24,
			"feeCents":       4000,
			"description":    "Cancel up to 24 hours before departure for a refund, less the cancellation fee.",
		}
	}
	return map[string]any{
		"refundable":     false,
		"freeUntilHours": 0,
		"feeCents":       0,
		"description":    "This fare is non-refundable. Taxes are returned if you cancel.",
	}
}

func (s *Server) logSearch(r *http.Request, outcome *Outcome, criteria store.Criteria) {
	event := s.log.Info().
		Str("search_id", outcome.Set.SearchID).
		Bool("cache_hit", outcome.CacheHit).
		Str("product_type", string(criteria.ProductType)).
		Int("provider_count", outcome.Set.ProvidersResponded).
		Int("result_count", outcome.Set.Count()).
		Str("request_id", httpx.RequestID(r.Context()))

	// Route fields only make sense for flights and city only for hotels.
	// Emitting both with one side blank makes the facet useless.
	if criteria.ProductType == store.Hotels {
		event = event.Str("city", criteria.City)
	} else {
		event = event.
			Str("origin", criteria.Origin).
			Str("destination", criteria.Destination).
			Str("cabin", criteria.Cabin)
	}
	event.Msg("Search completed")
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, err *apierr.Error) {
	event := s.log.Warn()
	if err.Status() >= 500 {
		event = s.log.Error()
	}
	event.
		Dict("error", zerolog.Dict().
			Str("kind", err.Kind).
			Str("message", err.Message)).
		Str("request_id", httpx.RequestID(r.Context())).
		Msg("Request failed")

	apierr.Write(w, httpx.RequestID(r.Context()), "", err)
}

func queryInt(r *http.Request, key string, fallback int) int {
	if value := r.URL.Query().Get(key); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			return parsed
		}
	}
	return fallback
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
