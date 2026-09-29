// Package store holds the canonical result model and everything that happens
// to a result set after it is built: filtering, sorting and pagination.
//
// One canonical shape is the whole point of this package. Four providers
// answer in three different schemas; everything downstream of `gds` sees only
// what is defined here.
package store

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
	"time"
)

type ProductType string

const (
	Flights ProductType = "flight"
	Hotels  ProductType = "hotel"
)

type Airline struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

type Segment struct {
	FlightID        string    `json:"flightId"`
	FlightNumber    string    `json:"flightNumber"`
	Origin          string    `json:"origin"`
	Destination     string    `json:"destination"`
	DepartureTime   time.Time `json:"departureTime"`
	ArrivalTime     time.Time `json:"arrivalTime"`
	Aircraft        string    `json:"aircraft,omitempty"`
	DurationMinutes int       `json:"durationMinutes"`
}

type AppliedRule struct {
	ID         int     `json:"id"`
	Pattern    string  `json:"pattern"`
	Type       string  `json:"type"`
	Value      float64 `json:"value"`
	Priority   int     `json:"priority"`
	DeltaCents int64   `json:"deltaCents"`
}

type Fare struct {
	Basis            string        `json:"basis"`
	Cabin            string        `json:"cabin"`
	BaseAmountCents  int64         `json:"baseAmountCents"`
	AdjustmentsCents int64         `json:"adjustmentsCents"`
	TaxesCents       int64         `json:"taxesCents"`
	TotalAmountCents int64         `json:"totalAmountCents"`
	Currency         string        `json:"currency"`
	Refundable       bool          `json:"refundable"`
	Changeable       bool          `json:"changeable"`
	BaggageAllowance int           `json:"baggageAllowance"`
	AppliedRules     []AppliedRule `json:"appliedRules,omitempty"`
}

type FlightResult struct {
	ID string `json:"id"`
	// Provider and OfferID are what checkout re-verifies against, so they
	// have to survive normalisation.
	Provider        string    `json:"provider"`
	OfferID         string    `json:"offerId"`
	Airline         Airline   `json:"airline"`
	Segments        []Segment `json:"segments"`
	Fare            Fare      `json:"fare"`
	DurationMinutes int       `json:"durationMinutes"`
	Stops           int       `json:"stops"`
	SeatsRemaining  int       `json:"seatsRemaining"`
}

type HotelRate struct {
	RatePlanID        string `json:"ratePlanId"`
	RoomName          string `json:"roomName"`
	MaxOccupancy      int    `json:"maxOccupancy"`
	BedConfig         string `json:"bedConfig,omitempty"`
	RateName          string `json:"rateName"`
	BreakfastIncluded bool   `json:"breakfastIncluded"`
	Refundable        bool   `json:"refundable"`
	CancellationHours int    `json:"cancellationHours"`
	NightlyCents      int64  `json:"nightlyPriceCents"`
	TotalCents        int64  `json:"totalPriceCents"`
	Currency          string `json:"currency"`
	RoomsAvailable    int    `json:"roomsAvailable"`
}

type HotelResult struct {
	ID           string      `json:"id"`
	Provider     string      `json:"provider"`
	PropertyID   string      `json:"propertyId"`
	Name         string      `json:"name"`
	StarRating   int         `json:"starRating"`
	ReviewScore  float64     `json:"reviewScore"`
	ReviewCount  int         `json:"reviewCount"`
	Neighborhood string      `json:"neighborhood,omitempty"`
	Address      string      `json:"address,omitempty"`
	Latitude     float64     `json:"latitude,omitempty"`
	Longitude    float64     `json:"longitude,omitempty"`
	Amenities    []string    `json:"amenities"`
	ImageSeed    int         `json:"imageSeed"`
	Rates        []HotelRate `json:"rates"`
	LeadCents    int64       `json:"leadPriceCents"`
	Currency     string      `json:"currency"`
}

// Criteria is the normalised request. It is stored with the result set so a
// paginated follow-up can be served without the caller repeating itself.
type Criteria struct {
	ProductType ProductType `json:"productType"`
	Origin      string      `json:"origin,omitempty"`
	Destination string      `json:"destination,omitempty"`
	City        string      `json:"city,omitempty"`
	DepartDate  string      `json:"departDate,omitempty"`
	ReturnDate  string      `json:"returnDate,omitempty"`
	CheckIn     string      `json:"checkIn,omitempty"`
	CheckOut    string      `json:"checkOut,omitempty"`
	Adults      int         `json:"adults"`
	Children    int         `json:"children"`
	Infants     int         `json:"infants"`
	Rooms       int         `json:"rooms,omitempty"`
	Cabin       string      `json:"cabin,omitempty"`
	Sort        string      `json:"sort"`
	Filters     Filters     `json:"filters"`
}

type Filters struct {
	MaxStops     *int     `json:"maxStops,omitempty"`
	Airlines     []string `json:"airlines,omitempty"`
	DepartWindow []string `json:"departWindow,omitempty"`
	MinStars     *int     `json:"minStars,omitempty"`
	Amenities    []string `json:"amenities,omitempty"`
}

type ResultSet struct {
	SearchID           string         `json:"searchId"`
	ProductType        ProductType    `json:"productType"`
	Criteria           Criteria       `json:"criteria"`
	CreatedAt          time.Time      `json:"createdAt"`
	ProvidersQueried   int            `json:"providersQueried"`
	ProvidersResponded int            `json:"providersResponded"`
	Flights            []FlightResult `json:"flights,omitempty"`
	Hotels             []HotelResult  `json:"hotels,omitempty"`
}

func (rs *ResultSet) Count() int {
	if rs.ProductType == Hotels {
		return len(rs.Hotels)
	}
	return len(rs.Flights)
}

// ResultID derives a stable id from the provider's offer id, so the same
// offer keeps the same id across repeated searches.
func ResultID(prefix, providerOfferID string) string {
	sum := sha256.Sum256([]byte(providerOfferID))
	return prefix + "_" + hex.EncodeToString(sum[:])[:16]
}

// ---------------------------------------------------------------- sorting --

const DefaultSort = "price_asc"

func SortFlights(results []FlightResult, order string) {
	switch order {
	case "price_desc":
		sort.SliceStable(results, func(i, j int) bool {
			return results[i].Fare.TotalAmountCents > results[j].Fare.TotalAmountCents
		})
	case "duration_asc":
		sort.SliceStable(results, func(i, j int) bool {
			return results[i].DurationMinutes < results[j].DurationMinutes
		})
	case "departure_asc":
		sort.SliceStable(results, func(i, j int) bool {
			return departureOf(results[i]).Before(departureOf(results[j]))
		})
	default:
		sort.SliceStable(results, func(i, j int) bool {
			return results[i].Fare.TotalAmountCents < results[j].Fare.TotalAmountCents
		})
	}
}

func SortHotels(results []HotelResult, order string) {
	switch order {
	case "price_desc":
		sort.SliceStable(results, func(i, j int) bool {
			return results[i].LeadCents > results[j].LeadCents
		})
	case "rating_desc":
		sort.SliceStable(results, func(i, j int) bool {
			return results[i].ReviewScore > results[j].ReviewScore
		})
	default:
		sort.SliceStable(results, func(i, j int) bool {
			return results[i].LeadCents < results[j].LeadCents
		})
	}
}

func departureOf(result FlightResult) time.Time {
	if len(result.Segments) == 0 {
		return time.Time{}
	}
	return result.Segments[0].DepartureTime
}

// -------------------------------------------------------------- filtering --

func FilterFlights(results []FlightResult, filters Filters) []FlightResult {
	if filters.MaxStops == nil && len(filters.Airlines) == 0 && len(filters.DepartWindow) != 2 {
		return results
	}

	allowed := make(map[string]struct{}, len(filters.Airlines))
	for _, code := range filters.Airlines {
		allowed[strings.ToUpper(code)] = struct{}{}
	}

	kept := results[:0:0]
	for _, result := range results {
		if filters.MaxStops != nil && result.Stops > *filters.MaxStops {
			continue
		}
		if len(allowed) > 0 {
			if _, ok := allowed[result.Airline.Code]; !ok {
				continue
			}
		}
		if len(filters.DepartWindow) == 2 && !withinWindow(result, filters.DepartWindow) {
			continue
		}
		kept = append(kept, result)
	}
	return kept
}

func FilterHotels(results []HotelResult, filters Filters) []HotelResult {
	if filters.MinStars == nil && len(filters.Amenities) == 0 {
		return results
	}

	kept := results[:0:0]
	for _, result := range results {
		if filters.MinStars != nil && result.StarRating < *filters.MinStars {
			continue
		}
		if !hasAll(result.Amenities, filters.Amenities) {
			continue
		}
		kept = append(kept, result)
	}
	return kept
}

// The window is local to the departure airport, which is what a traveller
// means by "I want to leave in the morning".
func withinWindow(result FlightResult, window []string) bool {
	departure := departureOf(result)
	if departure.IsZero() {
		return false
	}
	clock := departure.UTC().Format("15:04")
	return clock >= window[0] && clock <= window[1]
}

func hasAll(have, want []string) bool {
	if len(want) == 0 {
		return true
	}
	present := make(map[string]struct{}, len(have))
	for _, value := range have {
		present[value] = struct{}{}
	}
	for _, value := range want {
		if _, ok := present[value]; !ok {
			return false
		}
	}
	return true
}

// ------------------------------------------------------------- pagination --

// Page clamps a one-based page request to the available range and returns the
// slice bounds.
func Page(total, page, size int) (start, end int) {
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 20
	}
	if size > 100 {
		size = 100
	}
	start = (page - 1) * size
	if start > total {
		start = total
	}
	end = start + size
	if end > total {
		end = total
	}
	return start, end
}
