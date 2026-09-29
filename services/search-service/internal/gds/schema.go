// Package gds talks to mock-gds and maps what comes back into the canonical
// result model.
//
// Three wire schemas arrive here: the v2 flight schema, TRVP's legacy shape,
// and the v2 hotel schema. Everything downstream sees only `store` types.
package gds

import "time"

// Providers are queried in parallel; the slowest one sets the response time,
// which is what makes the trace waterfall worth looking at.
var Providers = []string{"AMDS", "SABR", "TRVP", "DRCT"}

// ------------------------------------------------------------ v2 flights --

type v2Segment struct {
	FlightID        string    `json:"flightId"`
	FlightNumber    string    `json:"flightNumber"`
	Origin          string    `json:"origin"`
	Destination     string    `json:"destination"`
	DepartureTime   time.Time `json:"departureTime"`
	ArrivalTime     time.Time `json:"arrivalTime"`
	Aircraft        string    `json:"aircraft"`
	DurationMinutes int       `json:"durationMinutes"`
}

type v2Fare struct {
	Basis            string `json:"basis"`
	Cabin            string `json:"cabin"`
	BaseAmountCents  int64  `json:"baseAmountCents"`
	TaxAmountCents   int64  `json:"taxAmountCents"`
	TotalAmountCents int64  `json:"totalAmountCents"`
	Currency         string `json:"currency"`
	Refundable       bool   `json:"refundable"`
	Changeable       bool   `json:"changeable"`
	BaggageAllowance int    `json:"baggageAllowance"`
}

type v2Offer struct {
	OfferID          string `json:"offerId"`
	MarketingCarrier struct {
		Code string `json:"code"`
		Name string `json:"name"`
	} `json:"marketingCarrier"`
	Segments       []v2Segment `json:"segments"`
	Fare           v2Fare      `json:"fare"`
	SeatsRemaining int         `json:"seatsRemaining"`
}

// -------------------------------------------------------- TRVP legacy v1 --

// Different field names, prices in major units rather than cents, and Y/N
// flags instead of booleans. The price field is the one that breaks naive
// mappers, so it gets converted explicitly and tested.
type trvpLeg struct {
	Flt  string    `json:"flt"`
	From string    `json:"from"`
	To   string    `json:"to"`
	Dep  time.Time `json:"dep"`
	Arr  time.Time `json:"arr"`
	Mins int       `json:"mins"`
	Eqp  string    `json:"eqp"`
}

type trvpOffer struct {
	ID      string    `json:"id"`
	Carrier string    `json:"carrier"`
	Legs    []trvpLeg `json:"legs"`
	Price   struct {
		Amt float64 `json:"amt"`
		Cur string  `json:"cur"`
	} `json:"price"`
	CabinClass string `json:"cabinClass"`
	FareCode   string `json:"fareCode"`
	Refund     string `json:"refund"`
	Chg        string `json:"chg"`
	Bags       int    `json:"bags"`
	Seats      int    `json:"seats"`
}

type flightResponse struct {
	Provider      string      `json:"provider"`
	RequestID     string      `json:"requestId"`
	SchemaVersion string      `json:"schemaVersion"`
	Offers        []v2Offer   `json:"offers"`
	Results       []trvpOffer `json:"results"`
}

// ------------------------------------------------------------- v2 hotels --

type v2Rate struct {
	RatePlanID        string `json:"ratePlanId"`
	RoomName          string `json:"roomName"`
	MaxOccupancy      int    `json:"maxOccupancy"`
	BedConfig         string `json:"bedConfig"`
	RateName          string `json:"rateName"`
	BreakfastIncluded bool   `json:"breakfastIncluded"`
	Refundable        bool   `json:"refundable"`
	CancellationHours int    `json:"cancellationHours"`
	NightlyCents      int64  `json:"nightlyPriceCents"`
	TotalCents        int64  `json:"totalPriceCents"`
	Currency          string `json:"currency"`
	RoomsAvailable    int    `json:"roomsAvailable"`
}

type v2Property struct {
	PropertyID   string   `json:"propertyId"`
	Name         string   `json:"name"`
	StarRating   int      `json:"starRating"`
	ReviewScore  float64  `json:"reviewScore"`
	ReviewCount  int      `json:"reviewCount"`
	Neighborhood string   `json:"neighborhood"`
	Address      string   `json:"address"`
	Latitude     float64  `json:"latitude"`
	Longitude    float64  `json:"longitude"`
	Amenities    []string `json:"amenities"`
	ImageSeed    int      `json:"imageSeed"`
	Rates        []v2Rate `json:"rates"`
}

type hotelResponse struct {
	Provider   string       `json:"provider"`
	RequestID  string       `json:"requestId"`
	Nights     int          `json:"nights"`
	Properties []v2Property `json:"properties"`
}
