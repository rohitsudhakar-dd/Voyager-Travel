package gds

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"voyager/search-service/internal/store"
)

// Each provider gets three seconds. Partial results are acceptable and are
// reported back as providersResponded, which is what makes a single slow
// provider visible rather than fatal (05-FUNCTIONALITY.md § 7 step 4).
const ProviderTimeout = 3 * time.Second

type Client struct {
	baseURL string
	http    *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		http: &http.Client{
			Timeout: ProviderTimeout,
			Transport: &http.Transport{
				MaxIdleConnsPerHost: 8,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

// ProviderOutcome is one provider's contribution to a fan-out.
type ProviderOutcome struct {
	Provider string
	Schema   string
	Flights  []store.FlightResult
	Hotels   []store.HotelResult
	Duration time.Duration
	Err      error
}

type FlightQuery struct {
	Origin      string `json:"origin"`
	Destination string `json:"destination"`
	DepartDate  string `json:"departDate"`
	ReturnDate  string `json:"returnDate,omitempty"`
	Cabin       string `json:"cabin"`
	Provider    string `json:"provider"`
	Passengers  struct {
		Adults   int `json:"adults"`
		Children int `json:"children"`
		Infants  int `json:"infants"`
	} `json:"passengers"`
}

type HotelQuery struct {
	City     string `json:"city"`
	CheckIn  string `json:"checkIn"`
	CheckOut string `json:"checkOut"`
	Guests   int    `json:"guests"`
	Rooms    int    `json:"rooms"`
	Provider string `json:"provider"`
}

// FanOutFlights queries every provider in parallel.
func (c *Client) FanOutFlights(ctx context.Context, query FlightQuery) []ProviderOutcome {
	outcomes := make([]ProviderOutcome, len(Providers))
	var wait sync.WaitGroup

	for index, provider := range Providers {
		wait.Add(1)
		go func(index int, provider string) {
			defer wait.Done()
			started := time.Now()

			scoped := query
			scoped.Provider = provider

			var response flightResponse
			err := c.post(ctx, "/gds/v2/flights/availability", scoped, &response)
			outcome := ProviderOutcome{
				Provider: provider,
				Duration: time.Since(started),
				Err:      err,
			}
			if err == nil {
				outcome.Schema = response.SchemaVersion
				response.Provider = provider
				outcome.Flights = normalizeFlights(response)
			}
			outcomes[index] = outcome
		}(index, provider)
	}

	wait.Wait()
	return outcomes
}

// FanOutHotels queries every provider in parallel.
func (c *Client) FanOutHotels(ctx context.Context, query HotelQuery) []ProviderOutcome {
	outcomes := make([]ProviderOutcome, len(Providers))
	var wait sync.WaitGroup

	for index, provider := range Providers {
		wait.Add(1)
		go func(index int, provider string) {
			defer wait.Done()
			started := time.Now()

			scoped := query
			scoped.Provider = provider

			var response hotelResponse
			err := c.post(ctx, "/gds/v2/hotels/availability", scoped, &response)
			outcome := ProviderOutcome{
				Provider: provider,
				Duration: time.Since(started),
				Err:      err,
			}
			if err == nil {
				response.Provider = provider
				outcome.Hotels = normalizeHotels(response)
			}
			outcomes[index] = outcome
		}(index, provider)
	}

	wait.Wait()
	return outcomes
}

// Seatmap backs the full-detail view of a single result.
func (c *Client) Seatmap(ctx context.Context, provider, flightID string) (map[string]any, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/gds/v2/seatmap/%s?provider=%s", c.baseURL, flightID, provider), nil)
	if err != nil {
		return nil, err
	}

	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return nil, &ProviderError{Provider: provider, StatusCode: response.StatusCode}
	}

	var decoded map[string]any
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return nil, err
	}
	return decoded, nil
}

func (c *Client) post(ctx context.Context, path string, body, into any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, ProviderTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path,
		bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return &ProviderError{
			Provider:   fmt.Sprint(bodyProvider(body)),
			StatusCode: response.StatusCode,
		}
	}
	return json.NewDecoder(response.Body).Decode(into)
}

func bodyProvider(body any) string {
	switch typed := body.(type) {
	case FlightQuery:
		return typed.Provider
	case HotelQuery:
		return typed.Provider
	default:
		return "unknown"
	}
}

// ProviderError carries the provider's own status through, so a 429 stays
// distinguishable from a 503 all the way up to the log line.
type ProviderError struct {
	Provider   string
	StatusCode int
}

func (e *ProviderError) Error() string {
	return fmt.Sprintf("provider %s returned %d", e.Provider, e.StatusCode)
}
