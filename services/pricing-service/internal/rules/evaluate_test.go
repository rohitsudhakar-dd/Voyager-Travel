package rules

import (
	"testing"
	"time"
)

func date(value string) time.Time {
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		panic(err)
	}
	return parsed
}

func intPtr(value int) *int { return &value }

// A Wednesday, well clear of both the blackout window and peak season.
var (
	departure = date("2026-10-14")
	now       = date("2026-09-01")
)

func baseOffer() Offer {
	return Offer{
		ID:            "fr_test",
		Origin:        "LHR",
		Destination:   "JFK",
		OriginRegion:  "UK",
		DestRegion:    "NA",
		FareClassCode: "ECOSTD",
		Cabin:         "economy",
		DepartDate:    departure,
		BaseCents:     20000,
		Currency:      "GBP",
	}
}

func rule(id int, pattern string, adjustment AdjustmentType, value float64, priority int) Rule {
	return Rule{
		ID:              id,
		FareClassCode:   "ECOSTD",
		RoutePattern:    pattern,
		AppliesFrom:     date("2026-01-01"),
		AppliesTo:       date("2027-01-01"),
		DayOfWeekMask:   127,
		AdjustmentType:  adjustment,
		AdjustmentValue: value,
		Priority:        priority,
	}
}

func TestIndexedPathOnlyVisitsCandidatePatterns(t *testing.T) {
	index := BuildIndex([]Rule{
		rule(1, "LHR-JFK", Percent, 10, 50),
		rule(2, "LHR-*", Fixed, 5, 40),
		rule(3, "*-JFK", Percent, -5, 30),
		rule(4, "UK-NA", Fixed, 2, 20),
		rule(5, "*-*", Percent, 1, 10),
		// None of these can match LHR-JFK.
		rule(6, "CDG-JFK", Percent, 99, 99),
		rule(7, "LHR-CDG", Percent, 99, 99),
		rule(8, "EU-APAC", Percent, 99, 99),
	})

	quote := priced(index, baseOffer(), now, false)

	if quote.RulesEvaluated != 5 {
		t.Fatalf("expected the five candidate patterns to be visited, got %d", quote.RulesEvaluated)
	}
	if len(quote.AppliedRules) != 5 {
		t.Fatalf("expected 5 applied rules, got %d", len(quote.AppliedRules))
	}
}

// The whole point of the hot path is that it produces the same answer, just
// far more expensively. If the two ever disagree the profiling demo is
// showing a bug rather than an inefficiency.
func TestHotPathAgreesWithIndexedPath(t *testing.T) {
	all := []Rule{
		rule(1, "LHR-JFK", Percent, 12.5, 90),
		rule(2, "LHR-*", Fixed, 15, 80),
		rule(3, "*-JFK", Percent, -7.5, 70),
		rule(4, "UK-NA", Fixed, -3, 60),
		rule(5, "*-*", Percent, 2, 50),
		rule(6, "CDG-FRA", Percent, 40, 95),
		rule(7, "APAC-OCE", Fixed, 80, 95),
	}
	index := BuildIndex(all)

	indexed := priced(index, baseOffer(), now, false)
	hot := priced(index, baseOffer(), now, true)

	if indexed.TotalCents != hot.TotalCents {
		t.Fatalf("indexed total %d, hot-path total %d", indexed.TotalCents, hot.TotalCents)
	}
	if len(indexed.AppliedRules) != len(hot.AppliedRules) {
		t.Fatalf("indexed applied %d rules, hot path applied %d",
			len(indexed.AppliedRules), len(hot.AppliedRules))
	}
	if hot.RulesEvaluated != len(all) {
		t.Fatalf("hot path should scan every rule, evaluated %d of %d",
			hot.RulesEvaluated, len(all))
	}
}

func TestRulesApplyInPriorityOrder(t *testing.T) {
	// 20000 +10% = 22000, then a flat 50.00 = 27000, then -50% = 13500.
	index := BuildIndex([]Rule{
		rule(1, "LHR-JFK", Percent, 10, 30),
		rule(2, "LHR-*", Fixed, 50, 20),
		rule(3, "*-JFK", Percent, -50, 10),
	})

	quote := priced(index, baseOffer(), now, false)

	want := int64(13500)
	if got := quote.BaseCents + quote.AdjustmentsCents; got != want {
		t.Fatalf("adjusted amount = %d, want %d", got, want)
	}
	if quote.TaxesCents != int64(float64(want)*TaxRate) {
		t.Fatalf("taxes = %d, want %d", quote.TaxesCents, int64(float64(want)*TaxRate))
	}
	if quote.TotalCents != want+quote.TaxesCents {
		t.Fatalf("total = %d, want %d", quote.TotalCents, want+quote.TaxesCents)
	}
}

func TestFareClassMustMatch(t *testing.T) {
	applicable := rule(1, "LHR-JFK", Percent, 25, 10)
	applicable.FareClassCode = "BIZFLEX"
	index := BuildIndex([]Rule{applicable})

	quote := priced(index, baseOffer(), now, false)

	if len(quote.AppliedRules) != 0 {
		t.Fatalf("a BIZFLEX rule must not price an ECOSTD offer")
	}
	if quote.AdjustmentsCents != 0 {
		t.Fatalf("adjustments = %d, want 0", quote.AdjustmentsCents)
	}
}

func TestDateWindowAndDayOfWeekMask(t *testing.T) {
	outOfWindow := rule(1, "LHR-JFK", Percent, 25, 10)
	outOfWindow.AppliesTo = date("2026-06-01")

	// 2026-10-14 is a Wednesday, which is bit 2.
	wrongDay := rule(2, "LHR-JFK", Percent, 25, 10)
	wrongDay.DayOfWeekMask = 127 &^ (1 << 2)

	quote := priced(BuildIndex([]Rule{outOfWindow, wrongDay}), baseOffer(), now, false)

	if len(quote.AppliedRules) != 0 {
		t.Fatalf("expected no rules to apply, got %d", len(quote.AppliedRules))
	}
}

func TestAdvancePurchaseWindow(t *testing.T) {
	// Departure is 43 days out from `now`.
	within := rule(1, "LHR-JFK", Percent, 10, 20)
	within.AdvancePurchaseDays = 21
	beyond := rule(2, "LHR-*", Percent, 10, 10)
	beyond.AdvancePurchaseDays = 90

	quote := priced(BuildIndex([]Rule{within, beyond}), baseOffer(), now, false)

	if len(quote.AppliedRules) != 1 || quote.AppliedRules[0].ID != 1 {
		t.Fatalf("only the 21-day advance rule should apply, got %+v", quote.AppliedRules)
	}
}

func TestMinimumStayRequiresAReturn(t *testing.T) {
	minStay := rule(1, "LHR-JFK", Percent, 10, 20)
	minStay.MinStayDays = intPtr(3)
	index := BuildIndex([]Rule{minStay})

	oneWay := priced(index, baseOffer(), now, false)
	if len(oneWay.AppliedRules) != 0 {
		t.Fatalf("a minimum-stay rule cannot apply to a one-way fare")
	}

	tooShort := baseOffer()
	shortReturn := date("2026-10-15")
	tooShort.ReturnDate = &shortReturn
	if applied := priced(index, tooShort, now, false).AppliedRules; len(applied) != 0 {
		t.Fatalf("a one-night stay must not satisfy a three-night minimum")
	}

	longEnough := baseOffer()
	lateReturn := date("2026-10-21")
	longEnough.ReturnDate = &lateReturn
	if applied := priced(index, longEnough, now, false).AppliedRules; len(applied) != 1 {
		t.Fatalf("a seven-night stay should satisfy a three-night minimum, got %d", len(applied))
	}
}

func TestConditionsAreRequirements(t *testing.T) {
	weekendOnly := rule(1, "LHR-JFK", Percent, 20, 10)
	weekendOnly.Conditions = map[string]bool{"weekend_surcharge": true}

	// A condition present but false places no requirement at all.
	indifferent := rule(2, "LHR-*", Percent, 5, 5)
	indifferent.Conditions = map[string]bool{"promo_eligible": false}

	index := BuildIndex([]Rule{weekendOnly, indifferent})

	midweek := priced(index, baseOffer(), now, false)
	if len(midweek.AppliedRules) != 1 || midweek.AppliedRules[0].ID != 2 {
		t.Fatalf("only the unconditional rule should apply midweek, got %+v", midweek.AppliedRules)
	}

	weekend := baseOffer()
	weekend.DepartDate = date("2026-10-17") // Saturday
	if applied := priced(index, weekend, now, false).AppliedRules; len(applied) != 2 {
		t.Fatalf("both rules should apply on a Saturday, got %d", len(applied))
	}
}

func TestDiscountsCannotProduceANegativeFare(t *testing.T) {
	index := BuildIndex([]Rule{
		rule(1, "LHR-JFK", Fixed, -5000, 10),
	})

	quote := priced(index, baseOffer(), now, false)

	if quote.BaseCents+quote.AdjustmentsCents < 0 {
		t.Fatalf("adjusted amount went negative: %d", quote.BaseCents+quote.AdjustmentsCents)
	}
	if quote.TotalCents < 0 {
		t.Fatalf("total went negative: %d", quote.TotalCents)
	}
}

func TestPatternMatchingAcceptsCodesAndRegions(t *testing.T) {
	offer := baseOffer()
	cases := map[string]bool{
		"LHR-JFK": true,
		"LHR-*":   true,
		"*-JFK":   true,
		"UK-NA":   true,
		"*-*":     true,
		"CDG-JFK": false,
		"LHR-CDG": false,
		"EU-NA":   false,
		"garbage": false,
	}
	for pattern, want := range cases {
		if got := patternMatches(pattern, offer); got != want {
			t.Errorf("patternMatches(%q) = %v, want %v", pattern, got, want)
		}
	}
}

// priced is Evaluate followed by the tax pass, which is how the API layer
// calls them. The two are separate so they can carry separate spans; every
// assertion here is about the finished quote, so the tests use them together.
func priced(index *Index, offer Offer, now time.Time, hotPath bool) Quote {
	quotes := []Quote{index.Evaluate(offer, now, hotPath)}
	ApplyTaxes(quotes)
	return quotes[0]
}
