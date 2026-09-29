package store

import "testing"

func intPtr(v int) *int { return &v }

func criteria() Criteria {
	return Criteria{
		ProductType: Flights,
		Origin:      "LHR",
		Destination: "JFK",
		DepartDate:  "2026-10-13",
		Adults:      1,
		Cabin:       "economy",
		Sort:        "price_asc",
	}
}

func TestIdenticalCriteriaProduceIdenticalKeys(t *testing.T) {
	if CacheKey(criteria()) != CacheKey(criteria()) {
		t.Fatal("the same criteria produced two different keys")
	}
}

// Filter order is a client-side accident, not a difference in meaning.
func TestFilterOrderDoesNotChangeTheKey(t *testing.T) {
	first := criteria()
	first.Filters = Filters{Airlines: []string{"VY", "AT", "ZP"}}

	second := criteria()
	second.Filters = Filters{Airlines: []string{"zp", "vy", "at"}}

	if CacheKey(first) != CacheKey(second) {
		t.Fatalf("filter ordering and case changed the key:\n  %s\n  %s",
			CacheKey(first), CacheKey(second))
	}
}

// Sorting is applied when a page is read, so it must not fragment the cache.
func TestSortOrderDoesNotChangeTheKey(t *testing.T) {
	ascending := criteria()
	descending := criteria()
	descending.Sort = "duration_asc"

	if CacheKey(ascending) != CacheKey(descending) {
		t.Fatal("sort order must not be part of the cache key")
	}
}

func TestMeaningfulDifferencesChangeTheKey(t *testing.T) {
	base := CacheKey(criteria())

	cases := map[string]func(*Criteria){
		"destination":  func(c *Criteria) { c.Destination = "BOS" },
		"depart date":  func(c *Criteria) { c.DepartDate = "2026-10-14" },
		"return date":  func(c *Criteria) { c.ReturnDate = "2026-10-20" },
		"adults":       func(c *Criteria) { c.Adults = 2 },
		"infants":      func(c *Criteria) { c.Infants = 1 },
		"cabin":        func(c *Criteria) { c.Cabin = "business" },
		"max stops":    func(c *Criteria) { c.Filters.MaxStops = intPtr(0) },
		"airlines":     func(c *Criteria) { c.Filters.Airlines = []string{"VY"} },
		"time window":  func(c *Criteria) { c.Filters.DepartWindow = []string{"06:00", "12:00"} },
		"product type": func(c *Criteria) { c.ProductType = Hotels },
	}

	for name, mutate := range cases {
		changed := criteria()
		mutate(&changed)
		if CacheKey(changed) == base {
			t.Errorf("changing the %s did not change the cache key", name)
		}
	}
}

func TestKeyIsNamespacedByProductType(t *testing.T) {
	flight := CacheKey(criteria())
	if got := flight[:15]; got != "search:flights:" {
		t.Fatalf("flight key prefix = %q, want %q", got, "search:flights:")
	}

	hotel := criteria()
	hotel.ProductType = Hotels
	if got := CacheKey(hotel)[:14]; got != "search:hotels:" {
		t.Fatalf("hotel key prefix = %q, want %q", got, "search:hotels:")
	}
}

// 16 hex characters of SHA-256 is short enough to read off a screen during a
// demo and long enough that collisions are not a practical concern.
func TestKeyHashIsSixteenHexCharacters(t *testing.T) {
	key := CacheKey(criteria())
	hash := key[len("search:flights:"):]
	if len(hash) != 16 {
		t.Fatalf("hash length = %d, want 16", len(hash))
	}
	for _, r := range hash {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			t.Fatalf("hash contains a non-hex character: %q", hash)
		}
	}
}

func TestPageClampsToRange(t *testing.T) {
	cases := []struct {
		total, page, size  int
		wantStart, wantEnd int
	}{
		{total: 34, page: 1, size: 20, wantStart: 0, wantEnd: 20},
		{total: 34, page: 2, size: 20, wantStart: 20, wantEnd: 34},
		{total: 34, page: 9, size: 20, wantStart: 34, wantEnd: 34},
		{total: 34, page: 0, size: 20, wantStart: 0, wantEnd: 20},
		{total: 5, page: 1, size: 0, wantStart: 0, wantEnd: 5},
		{total: 500, page: 1, size: 5000, wantStart: 0, wantEnd: 100},
	}
	for _, c := range cases {
		start, end := Page(c.total, c.page, c.size)
		if start != c.wantStart || end != c.wantEnd {
			t.Errorf("Page(%d,%d,%d) = (%d,%d), want (%d,%d)",
				c.total, c.page, c.size, start, end, c.wantStart, c.wantEnd)
		}
	}
}
