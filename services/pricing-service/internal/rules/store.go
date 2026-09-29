package rules

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"gopkg.in/DataDog/dd-trace-go.v1/ddtrace/tracer"
)

// Store keeps the rule index in memory and refreshes it on a timer. Reads
// take an atomic pointer swap, so pricing never blocks on a reload.
type Store struct {
	pool   *pgxpool.Pool
	logger zerolog.Logger

	index   atomic.Pointer[Index]
	regions atomic.Pointer[map[string]string]

	once sync.Once
}

func NewStore(pool *pgxpool.Pool, logger zerolog.Logger) *Store {
	return &Store{pool: pool, logger: logger}
}

func (s *Store) Index() *Index {
	if index := s.index.Load(); index != nil {
		return index
	}
	return BuildIndex(nil)
}

// Region maps an airport to its region, for the region-to-region rule
// patterns. Unknown airports fall back to INTL, matching the seeder.
func (s *Store) Region(iata string) string {
	if regions := s.regions.Load(); regions != nil {
		if region, ok := (*regions)[iata]; ok {
			return region
		}
	}
	return "INTL"
}

// Start loads once synchronously so the service is never ready with an empty
// rule set, then refreshes on the configured interval.
func (s *Store) Start(ctx context.Context, interval time.Duration) error {
	if err := s.reload(ctx); err != nil {
		return err
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := s.reload(ctx); err != nil {
					s.logger.Error().
						Dict("error", zerolog.Dict().
							Str("kind", "DatabaseError").
							Str("message", err.Error())).
						Msg("Fare rule reload failed")
				}
			}
		}
	}()
	return nil
}

// reload is wrapped rather than the handler path because the refresh runs on
// a timer, off any request. Without its own span the two Postgres reads --
// the largest queries this service makes -- belong to no trace at all.
func (s *Store) reload(ctx context.Context) (err error) {
	span, ctx := tracer.StartSpanFromContext(ctx, "pricing.load_rules")
	defer func() { span.Finish(tracer.WithError(err)) }()

	started := time.Now()

	loaded, err := s.loadRules(ctx)
	if err != nil {
		return err
	}
	regions, err := s.loadRegions(ctx)
	if err != nil {
		return err
	}

	index := BuildIndex(loaded)
	s.index.Store(index)
	s.regions.Store(&regions)

	s.logger.Info().
		Int("rule_count", len(loaded)).
		Int("pattern_count", len(index.byPattern)).
		Int("airport_count", len(regions)).
		Int64("duration", time.Since(started).Nanoseconds()).
		Msg("Fare rules loaded")
	return nil
}

func (s *Store) loadRules(ctx context.Context) ([]Rule, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, fare_class_code, route_pattern, applies_from, applies_to,
		       day_of_week_mask, advance_purchase_days, min_stay_days,
		       max_stay_days, adjustment_type, adjustment_value, priority,
		       conditions
		  FROM voyager.fare_rules`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	loaded := make([]Rule, 0, 2048)
	for rows.Next() {
		var rule Rule
		var adjustmentType string
		var conditions []byte
		if err := rows.Scan(
			&rule.ID, &rule.FareClassCode, &rule.RoutePattern,
			&rule.AppliesFrom, &rule.AppliesTo, &rule.DayOfWeekMask,
			&rule.AdvancePurchaseDays, &rule.MinStayDays, &rule.MaxStayDays,
			&adjustmentType, &rule.AdjustmentValue, &rule.Priority,
			&conditions,
		); err != nil {
			return nil, err
		}
		rule.AdjustmentType = AdjustmentType(adjustmentType)
		if len(conditions) > 0 {
			_ = json.Unmarshal(conditions, &rule.Conditions)
		}
		loaded = append(loaded, rule)
	}
	return loaded, rows.Err()
}

func (s *Store) loadRegions(ctx context.Context) (map[string]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT iata_code, country_code FROM voyager.airports`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	regions := make(map[string]string, 512)
	for rows.Next() {
		var iata, country string
		if err := rows.Scan(&iata, &country); err != nil {
			return nil, err
		}
		regions[iata] = regionForCountry(country)
	}
	return regions, rows.Err()
}

// The same mapping the seeder uses (tools/seeder/voyager_seed/reference.py).
// It is duplicated rather than shared because these are separate services in
// separate languages; if it drifts, region-pattern rules stop matching and
// prices move, so keep the two in step.
var countryRegion = map[string]string{
	"GB": "UK",
	"IE": "EU", "FR": "EU", "DE": "EU", "ES": "EU", "IT": "EU", "NL": "EU",
	"BE": "EU", "LU": "EU", "PT": "EU", "AT": "EU", "CH": "EU", "SE": "EU",
	"NO": "EU", "DK": "EU", "FI": "EU", "IS": "EU", "PL": "EU", "CZ": "EU",
	"SK": "EU", "HU": "EU", "RO": "EU", "BG": "EU", "GR": "EU", "HR": "EU",
	"SI": "EU", "EE": "EU", "LV": "EU", "LT": "EU", "MT": "EU", "CY": "EU",
	"RS": "EU", "UA": "EU",
	"US": "NA", "CA": "NA", "MX": "NA",
	"BR": "LATAM", "AR": "LATAM", "CL": "LATAM", "CO": "LATAM", "PE": "LATAM",
	"UY": "LATAM", "EC": "LATAM", "PA": "LATAM", "CR": "LATAM", "DO": "LATAM",
	"CU": "LATAM", "JM": "LATAM",
	"AE": "MEA", "QA": "MEA", "SA": "MEA", "KW": "MEA", "BH": "MEA",
	"OM": "MEA", "IL": "MEA", "JO": "MEA", "LB": "MEA", "TR": "MEA",
	"EG": "MEA",
	"MA": "AFR", "TN": "AFR", "DZ": "AFR", "ZA": "AFR", "KE": "AFR",
	"NG": "AFR", "GH": "AFR", "ET": "AFR", "TZ": "AFR", "SN": "AFR",
	"MU": "AFR", "RW": "AFR",
	"IN": "APAC", "SG": "APAC", "MY": "APAC", "TH": "APAC", "VN": "APAC",
	"ID": "APAC", "PH": "APAC", "CN": "APAC", "HK": "APAC", "TW": "APAC",
	"JP": "APAC", "KR": "APAC", "LK": "APAC", "NP": "APAC", "BD": "APAC",
	"KH": "APAC", "MV": "APAC",
	"AU": "OCE", "NZ": "OCE", "FJ": "OCE",
}

func regionForCountry(code string) string {
	if region, ok := countryRegion[code]; ok {
		return region
	}
	return "INTL"
}
