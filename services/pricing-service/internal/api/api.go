// Package api serves the pricing HTTP surface.
package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"voyager/pricing-service/internal/apierr"
	"voyager/pricing-service/internal/chaos"
	"voyager/pricing-service/internal/config"
	"voyager/pricing-service/internal/httpx"
	"voyager/pricing-service/internal/rules"
)

// One batch caps at 50 offers, which is what search-service sends per page
// (05-FUNCTIONALITY.md § 7 step 6).
const MaxBatchSize = 50

type Server struct {
	cfg    config.Config
	log    zerolog.Logger
	store  *rules.Store
	chaos  *chaos.Reader
	pool   *pgxpool.Pool
	redis  *redis.Client
	router chi.Router
}

func NewServer(
	cfg config.Config,
	log zerolog.Logger,
	store *rules.Store,
	flags *chaos.Reader,
	pool *pgxpool.Pool,
	rdb *redis.Client,
) *Server {
	s := &Server{cfg: cfg, log: log, store: store, chaos: flags, pool: pool, redis: rdb}

	router := chi.NewRouter()
	router.Use(httpx.WithRequestID)
	router.Use(httpx.AccessLog(log, flags.ActiveFlags))

	router.Get("/health", s.health)
	router.Get("/ready", s.ready)
	router.Post("/v1/price/flight", s.priceOne)
	router.Post("/v1/price/hotel", s.priceOne)
	router.Post("/v1/price/batch", s.priceBatch)

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
		"rules":   s.store.Index().Len(),
	})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, s.cfg.ReadinessTimeout)
	defer cancel()

	checks := map[string]string{"postgres": "ok", "redis": "ok", "fare_rules": "ok"}
	if err := s.pool.Ping(ctx); err != nil {
		checks["postgres"] = "error: " + err.Error()
	}
	if err := s.redis.Ping(ctx).Err(); err != nil {
		checks["redis"] = "error: " + err.Error()
	}
	// A pricing service with no rules loaded will happily return wrong
	// numbers, so it is not ready.
	if s.store.Index().Len() == 0 {
		checks["fare_rules"] = "error: no rules loaded"
	}

	status := http.StatusOK
	state := "ready"
	for _, value := range checks {
		if value != "ok" {
			status = http.StatusServiceUnavailable
			state = "not_ready"
		}
	}
	writeJSON(w, status, map[string]any{"status": state, "checks": checks})
}

// --------------------------------------------------------------- pricing --

type offerRequest struct {
	ID            string  `json:"id"`
	ProductType   string  `json:"productType"`
	Origin        string  `json:"origin"`
	Destination   string  `json:"destination"`
	DepartDate    string  `json:"departDate"`
	ReturnDate    *string `json:"returnDate"`
	FareClass     string  `json:"fareClass"`
	Cabin         string  `json:"cabin"`
	BaseCents     int64   `json:"baseAmountCents"`
	Currency      string  `json:"currency"`
	Corporate     bool    `json:"corporate"`
	PromoEligible bool    `json:"promoEligible"`
}

type batchRequest struct {
	Offers []offerRequest `json:"offers"`
}

func (s *Server) priceOne(w http.ResponseWriter, r *http.Request) {
	var request offerRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		s.fail(w, r, apierr.InvalidPricingRequest("Request body is not valid JSON."))
		return
	}
	s.chaos.Refresh(r.Context())

	quotes, err := s.evaluate([]offerRequest{request})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, quotes[0])
}

func (s *Server) priceBatch(w http.ResponseWriter, r *http.Request) {
	var request batchRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		s.fail(w, r, apierr.InvalidPricingRequest("Request body is not valid JSON."))
		return
	}
	if len(request.Offers) > MaxBatchSize {
		s.fail(w, r, apierr.BatchTooLarge(MaxBatchSize))
		return
	}
	s.chaos.Refresh(r.Context())

	started := time.Now()
	quotes, err := s.evaluate(request.Offers)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"quotes":        quotes,
		"rulesInMemory": s.store.Index().Len(),
		"hotPath":       s.chaos.Bool("pricing_hot_path"),
		"durationMs":    time.Since(started).Milliseconds(),
	})
}

func (s *Server) evaluate(requests []offerRequest) ([]rules.Quote, *apierr.Error) {
	index := s.store.Index()
	hotPath := s.chaos.Bool("pricing_hot_path")
	now := time.Now().UTC()

	quotes := make([]rules.Quote, 0, len(requests))
	for _, request := range requests {
		if request.BaseCents <= 0 || request.Currency == "" {
			return nil, apierr.InvalidPricingRequest(
				"Every offer needs a positive baseAmountCents and a currency.")
		}

		departDate, err := time.Parse("2006-01-02", request.DepartDate)
		if err != nil {
			return nil, apierr.InvalidPricingRequest("departDate must be YYYY-MM-DD.")
		}

		var returnDate *time.Time
		if request.ReturnDate != nil && *request.ReturnDate != "" {
			parsed, err := time.Parse("2006-01-02", *request.ReturnDate)
			if err != nil {
				return nil, apierr.InvalidPricingRequest("returnDate must be YYYY-MM-DD.")
			}
			returnDate = &parsed
		}

		quotes = append(quotes, index.Evaluate(rules.Offer{
			ID:            request.ID,
			Origin:        request.Origin,
			Destination:   request.Destination,
			OriginRegion:  s.store.Region(request.Origin),
			DestRegion:    s.store.Region(request.Destination),
			FareClassCode: request.FareClass,
			Cabin:         request.Cabin,
			DepartDate:    departDate,
			ReturnDate:    returnDate,
			BaseCents:     request.BaseCents,
			Currency:      request.Currency,
			Corporate:     request.Corporate,
			PromoEligible: request.PromoEligible,
		}, now, hotPath))
	}
	return quotes, nil
}

// ----------------------------------------------------------------- utils --

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

	// traceId is empty until phase 8 wires the tracer; the envelope shape
	// does not change when it arrives.
	apierr.Write(w, httpx.RequestID(r.Context()), "", err)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
