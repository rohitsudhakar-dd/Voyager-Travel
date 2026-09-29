// Package rules holds the fare-rule store and the evaluation loop.
//
// This is the code phase 10 points the profiler at, so it is written the way
// a competent team would actually write it: an index built once at load time,
// and a bypass that is slow for a reason people recognise -- not an
// artificial spin loop (05-FUNCTIONALITY.md § 7.1).
package rules

import (
	"strings"
	"time"
)

type AdjustmentType string

const (
	Percent AdjustmentType = "percent"
	Fixed   AdjustmentType = "fixed"
)

type Rule struct {
	ID                  int
	FareClassCode       string
	RoutePattern        string
	AppliesFrom         time.Time
	AppliesTo           time.Time
	DayOfWeekMask       int
	AdvancePurchaseDays int
	MinStayDays         *int
	MaxStayDays         *int
	AdjustmentType      AdjustmentType
	AdjustmentValue     float64
	Priority            int
	Conditions          map[string]bool
}

// Offer is everything the engine needs to price one result.
type Offer struct {
	ID            string
	Origin        string
	Destination   string
	OriginRegion  string
	DestRegion    string
	FareClassCode string
	Cabin         string
	DepartDate    time.Time
	ReturnDate    *time.Time
	BaseCents     int64
	Currency      string

	// Flags the caller asserts about the booking context. A rule that
	// requires one of these only applies when it is set.
	Corporate     bool
	PromoEligible bool
}

// AppliedRule records one rule's contribution, so a demo can open a result
// and see exactly why the price is what it is.
type AppliedRule struct {
	ID         int            `json:"id"`
	Pattern    string         `json:"pattern"`
	Type       AdjustmentType `json:"type"`
	Value      float64        `json:"value"`
	Priority   int            `json:"priority"`
	DeltaCents int64          `json:"deltaCents"`
}

// Matches the seeder's tax rate (tools/seeder/voyager_seed/bookings.py). The
// two must agree or seeded history and live pricing tell different stories.
const TaxRate = 0.11

// Blackout window: the fortnight either side of new year, when a rule
// carrying the `blackout` condition takes effect.
var blackoutStart = time.Date(0, time.December, 20, 0, 0, 0, 0, time.UTC)

func isBlackout(date time.Time) bool {
	month, day := date.Month(), date.Day()
	return (month == time.December && day >= blackoutStart.Day()) ||
		(month == time.January && day <= 3)
}

func isWeekend(date time.Time) bool {
	weekday := date.Weekday()
	return weekday == time.Saturday || weekday == time.Sunday
}

func isPeakSeason(date time.Time) bool {
	switch date.Month() {
	case time.July, time.August, time.December:
		return true
	default:
		return false
	}
}

// candidateKeys returns the route patterns that could possibly match this
// offer. There are exactly five, which is why the indexed path touches ~5
// rules per offer rather than 2,000.
func candidateKeys(offer Offer) [5]string {
	return [5]string{
		offer.Origin + "-" + offer.Destination,
		offer.Origin + "-*",
		"*-" + offer.Destination,
		offer.OriginRegion + "-" + offer.DestRegion,
		"*-*",
	}
}

// patternMatches answers the same question as candidateKeys, but by walking
// the pattern instead of looking it up. Only the hot path needs it.
func patternMatches(pattern string, offer Offer) bool {
	origin, destination, found := strings.Cut(pattern, "-")
	if !found {
		return false
	}
	originOK := origin == "*" || origin == offer.Origin || origin == offer.OriginRegion
	destOK := destination == "*" || destination == offer.Destination || destination == offer.DestRegion
	return originOK && destOK
}

// applies runs every predicate on the rule that does not involve the route.
func (r Rule) applies(offer Offer, now time.Time) bool {
	if r.FareClassCode != offer.FareClassCode {
		return false
	}

	depart := offer.DepartDate
	if depart.Before(r.AppliesFrom) || depart.After(r.AppliesTo) {
		return false
	}

	// The mask is a bitfield over weekdays, Monday at bit 0.
	weekdayBit := 1 << ((int(depart.Weekday()) + 6) % 7)
	if r.DayOfWeekMask&weekdayBit == 0 {
		return false
	}

	if r.AdvancePurchaseDays > 0 {
		daysAhead := int(depart.Sub(now).Hours() / 24)
		if daysAhead < r.AdvancePurchaseDays {
			return false
		}
	}

	if offer.ReturnDate != nil {
		stay := int(offer.ReturnDate.Sub(depart).Hours() / 24)
		if r.MinStayDays != nil && stay < *r.MinStayDays {
			return false
		}
		if r.MaxStayDays != nil && stay > *r.MaxStayDays {
			return false
		}
	} else if r.MinStayDays != nil {
		// A minimum-stay rule cannot apply to a one-way fare.
		return false
	}

	// Conditions are requirements, not hints: a rule that carries one only
	// applies when that condition actually holds.
	for key, required := range r.Conditions {
		if !required {
			continue
		}
		switch key {
		case "weekend_surcharge":
			if !isWeekend(depart) {
				return false
			}
		case "peak_season":
			if !isPeakSeason(depart) {
				return false
			}
		case "blackout":
			if !isBlackout(depart) {
				return false
			}
		case "corporate_discount":
			if !offer.Corporate {
				return false
			}
		case "promo_eligible":
			if !offer.PromoEligible {
				return false
			}
		}
	}

	return true
}

func (r Rule) delta(amount int64) int64 {
	if r.AdjustmentType == Percent {
		return int64(float64(amount) * r.AdjustmentValue / 100.0)
	}
	return int64(r.AdjustmentValue * 100)
}
