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
	Code string `json:"iataCode"`
	Name string `json:"name"`
	// LogoSeed picks one of the generated crest designs. Voyager invents every
	// airline, so there is no real mark to fetch and the seed has to be stable
	// across searches or the same carrier changes logo as you page.
	LogoSeed int `json:"logoSeed"`
}

type Segment struct {
	FlightID     string `json:"flightId"`
	FlightNumber string `json:"flightNumber"`
	// AirlineCode repeats the result's carrier on every segment. A codeshare
	// leg is operated by someone other than the airline that sold the ticket,
	// and the segment list is the only place that can say so.
	AirlineCode     string    `json:"airlineCode"`
	Origin          string    `json:"origin"`
	Destination     string    `json:"destination"`
	DepartureTime   time.Time `json:"departAt"`
	ArrivalTime     time.Time `json:"arriveAt"`
	Aircraft        string    `json:"aircraftType"`
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
	Basis            string        `json:"fareClassCode"`
	Cabin            string        `json:"cabin"`
	BaseAmountCents  int64         `json:"baseCents"`
	AdjustmentsCents int64         `json:"adjustmentsCents"`
	TaxesCents       int64         `json:"taxesCents"`
	TotalAmountCents int64         `json:"totalCents"`
	Currency         string        `json:"currency"`
	Refundable       bool          `json:"refundable"`
	Changeable       bool          `json:"changeable"`
	BaggageAllowance int           `json:"baggageIncluded"`
	// Duplicated from the result so the fare card has everything it renders in
	// one object; the seat count is what turns "£412" into "£412, 2 left".
	SeatsRemaining int           `json:"seatsRemaining"`
	AppliedRules   []AppliedRule `json:"appliedRules,omitempty"`
}

type FlightResult struct {
	ID          string      `json:"id"`
	ProductType ProductType `json:"productType"`
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
	ProductType  ProductType `json:"productType"`
	Provider     string      `json:"provider"`
	PropertyID   string      `json:"propertyId"`
	Name         string      `json:"name"`
	StarRating   int         `json:"starRating"`
	ReviewScore  float64     `json:"reviewScore"`
	ReviewCount  int         `json:"reviewCount"`
	CityName     string      `json:"cityName"`
	// No omitempty: the client's schema wants the key present and either a
	// string or null, and an omitted key is neither.
	Neighborhood string      `json:"neighborhood"`
	Address      string      `json:"address,omitempty"`
	Latitude     float64     `json:"latitude,omitempty"`
	Longitude    float64     `json:"longitude,omitempty"`
	Amenities    []string    `json:"amenities"`
	ImageSeed    int         `json:"imageSeed"`
	Rates        []HotelRate `json:"rates"`
	LeadCents    int64       `json:"leadPriceCents"`
	Currency     string      `json:"currency"`

	// The lead rate, repeated flat. A result card shows one price and one room,
	// and reaching into rates[0] to find them would make every consumer repeat
	// the "cheapest rate wins" rule that Finalize already applies once here.
	// The full list stays in Rates for the property page.
	RoomName          string `json:"roomName"`
	RatePlanName      string `json:"ratePlanName"`
	BreakfastIncluded bool   `json:"breakfastIncluded"`
	Refundable        bool   `json:"refundable"`
	RoomsAvailable    int    `json:"roomsAvailable"`
	Nights            int    `json:"nights"`
	NightlyCents      int64  `json:"nightlyPriceCents"`
	TaxesCents        int64  `json:"taxesCents"`
	TotalCents        int64  `json:"totalCents"`
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

// FinalizeFlights fills the fields the client contract requires but no
// provider sends.
//
// They are derived here, once, rather than in each of the two normalisers:
// the providers disagree about almost everything else, but none of them has
// an opinion about these. A missing one is not a cosmetic problem -- the
// browser parses this payload against a schema, so one absent field rejects
// the whole result set and the results page renders nothing at all.
func FinalizeFlights(results []FlightResult) {
	for i := range results {
		results[i].ProductType = Flights
		results[i].Airline.LogoSeed = logoSeed(results[i].Airline.Code)
		results[i].Fare.SeatsRemaining = results[i].SeatsRemaining
		for j := range results[i].Segments {
			// Only where the provider did not name an operating carrier. A
			// codeshare leg that says so must keep saying so.
			if results[i].Segments[j].AirlineCode == "" {
				results[i].Segments[j].AirlineCode = results[i].Airline.Code
			}
		}
	}
}

// FinalizeHotels is the hotel half of the same contract.
//
// It also flattens the cheapest rate onto the result. Providers return every
// rate plan for a property, but a search result shows one price, and which one
// that is has to be decided somewhere. Deciding it here means the sort, the
// card, and the pricing call all agree about which rate they are talking
// about.
//
// Money is deliberately left pre-tax: pricing-service owns tax
// (05-FUNCTIONALITY.md § 7), and priceHotels overwrites these three fields
// with its answer a moment later.
func FinalizeHotels(results []HotelResult, cityName string, nights int) {
	for i := range results {
		results[i].ProductType = Hotels
		results[i].CityName = cityName
		results[i].Nights = nights

		lead, ok := cheapestRate(results[i].Rates)
		if !ok {
			continue
		}
		results[i].RoomName = lead.RoomName
		results[i].RatePlanName = lead.RateName
		results[i].BreakfastIncluded = lead.BreakfastIncluded
		results[i].Refundable = lead.Refundable
		results[i].RoomsAvailable = lead.RoomsAvailable
		results[i].NightlyCents = lead.NightlyCents
		results[i].TotalCents = lead.TotalCents
		results[i].Currency = lead.Currency
	}
}

// cheapestRate picks the rate a result is sold at. Ties go to the earlier
// rate so that the same property does not swap rooms between two searches
// that returned the same rates in the same order.
func cheapestRate(rates []HotelRate) (HotelRate, bool) {
	best := -1
	for i := range rates {
		if best == -1 || rates[i].TotalCents < rates[best].TotalCents {
			best = i
		}
	}
	if best == -1 {
		return HotelRate{}, false
	}
	return rates[best], true
}

// Nights counts the nights in a stay. Zero when either date is missing or the
// pair is the wrong way round, which the request schema already rejects.
func Nights(checkIn, checkOut string) int {
	const layout = "2006-01-02"
	start, err := time.Parse(layout, checkIn)
	if err != nil {
		return 0
	}
	end, err := time.Parse(layout, checkOut)
	if err != nil {
		return 0
	}
	if nights := int(end.Sub(start).Hours() / 24); nights > 0 {
		return nights
	}
	return 0
}

// logoSeed maps a carrier code onto one of the generated crest designs. FNV-1a
// rather than the raw bytes so that ZP and PZ do not collide onto one design.
func logoSeed(code string) int {
	const offset, prime = 2166136261, 16777619
	hash := uint32(offset)
	for i := 0; i < len(code); i++ {
		hash ^= uint32(code[i])
		hash *= prime
	}
	return int(hash % 1000)
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
