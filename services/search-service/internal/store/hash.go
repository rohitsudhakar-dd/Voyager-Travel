package store

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
)

// CacheKey builds the Redis key for a search (05-FUNCTIONALITY.md § 7 step 2).
//
// The canonical form is deliberately boring: fixed field order, uppercase
// codes, sorted filter values. Two requests that mean the same thing must
// produce the same key, or the cache-hit demo quietly stops working.
//
// `sort` is not part of the key. Ordering is a presentation concern applied
// when a page is read, so re-sorting the same search reuses the cached set
// rather than re-querying four providers.
func CacheKey(c Criteria) string {
	parts := []string{
		payloadVersion,
		string(c.ProductType),
		c.Origin,
		c.Destination,
		c.City,
		c.DepartDate,
		c.ReturnDate,
		c.CheckIn,
		c.CheckOut,
		"a" + strconv.Itoa(c.Adults),
		"c" + strconv.Itoa(c.Children),
		"i" + strconv.Itoa(c.Infants),
		"r" + strconv.Itoa(c.Rooms),
		c.Cabin,
		canonicalFilters(c.Filters),
	}

	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return "search:" + string(c.ProductType) + "s:" + hex.EncodeToString(sum[:])[:16]
}

// payloadVersion is part of every key so that a release which changes the
// shape of a stored result cannot serve the previous shape.
//
// A cached set is JSON, and Go fills a field it cannot find with the zero
// value rather than an error. Renaming a field therefore does not produce a
// miss or a failure: it produces a complete-looking result in which every
// renamed field is empty -- a price of 0, a departure of year 1 -- which the
// browser then rejects against its schema, leaving an empty results page and
// nothing anywhere to say why. Bump this whenever a json tag in result.go
// changes.
const payloadVersion = "v3"

func canonicalFilters(f Filters) string {
	parts := make([]string, 0, 5)
	if f.MaxStops != nil {
		parts = append(parts, "maxStops="+strconv.Itoa(*f.MaxStops))
	}
	if len(f.Airlines) > 0 {
		parts = append(parts, "airlines="+sortedUpper(f.Airlines))
	}
	if len(f.DepartWindow) == 2 {
		parts = append(parts, "departWindow="+f.DepartWindow[0]+"-"+f.DepartWindow[1])
	}
	if f.MinStars != nil {
		parts = append(parts, "minStars="+strconv.Itoa(*f.MinStars))
	}
	if len(f.Amenities) > 0 {
		parts = append(parts, "amenities="+sortedLower(f.Amenities))
	}
	return strings.Join(parts, ";")
}

func sortedUpper(values []string) string {
	normalized := make([]string, len(values))
	for i, value := range values {
		normalized[i] = strings.ToUpper(strings.TrimSpace(value))
	}
	sort.Strings(normalized)
	return strings.Join(normalized, ",")
}

func sortedLower(values []string) string {
	normalized := make([]string, len(values))
	for i, value := range values {
		normalized[i] = strings.ToLower(strings.TrimSpace(value))
	}
	sort.Strings(normalized)
	return strings.Join(normalized, ",")
}

// ResultSetKey is where the full set lives, keyed by the id handed back to
// the caller.
func ResultSetKey(searchID string) string {
	return "search:results:" + searchID
}
