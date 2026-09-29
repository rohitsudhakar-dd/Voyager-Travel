// Package pricing is the client for pricing-service.
package pricing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	httptrace "gopkg.in/DataDog/dd-trace-go.v1/contrib/net/http"
	"time"
)

// pricing-service caps a batch at 50 offers, which is one page of results
// with room to spare (05-FUNCTIONALITY.md § 7 step 6).
const MaxBatchSize = 50

type Client struct {
	baseURL string
	http    *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		// Wrapped so the pricing call is a child of the search span rather
		// than a separate trace that has to be correlated by hand.
		http: httptrace.WrapClient(&http.Client{Timeout: 5 * time.Second}),
	}
}

type Offer struct {
	ID          string  `json:"id"`
	ProductType string  `json:"productType"`
	Origin      string  `json:"origin,omitempty"`
	Destination string  `json:"destination,omitempty"`
	DepartDate  string  `json:"departDate"`
	ReturnDate  *string `json:"returnDate,omitempty"`
	FareClass   string  `json:"fareClass"`
	Cabin       string  `json:"cabin"`
	BaseCents   int64   `json:"baseAmountCents"`
	Currency    string  `json:"currency"`
}

type AppliedRule struct {
	ID         int     `json:"id"`
	Pattern    string  `json:"pattern"`
	Type       string  `json:"type"`
	Value      float64 `json:"value"`
	Priority   int     `json:"priority"`
	DeltaCents int64   `json:"deltaCents"`
}

type Quote struct {
	OfferID          string        `json:"id"`
	BaseCents        int64         `json:"baseAmountCents"`
	AdjustmentsCents int64         `json:"adjustmentsCents"`
	TaxesCents       int64         `json:"taxesCents"`
	TotalCents       int64         `json:"totalAmountCents"`
	Currency         string        `json:"currency"`
	AppliedRules     []AppliedRule `json:"appliedRules"`
	RulesEvaluated   int           `json:"rulesEvaluated"`
}

type batchResponse struct {
	Quotes        []Quote `json:"quotes"`
	RulesInMemory int     `json:"rulesInMemory"`
	HotPath       bool    `json:"hotPath"`
}

// Batch prices up to MaxBatchSize offers in one call and returns the quotes
// keyed by offer id.
func (c *Client) Batch(ctx context.Context, offers []Offer) (map[string]Quote, error) {
	if len(offers) == 0 {
		return map[string]Quote{}, nil
	}
	if len(offers) > MaxBatchSize {
		offers = offers[:MaxBatchSize]
	}

	encoded, err := json.Marshal(map[string]any{"offers": offers})
	if err != nil {
		return nil, err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/v1/price/batch", bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("pricing-service returned %d", response.StatusCode)
	}

	var decoded batchResponse
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return nil, err
	}

	quotes := make(map[string]Quote, len(decoded.Quotes))
	for _, quote := range decoded.Quotes {
		quotes[quote.OfferID] = quote
	}
	return quotes, nil
}

func (c *Client) Ping(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/health", nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("pricing-service health returned %d", response.StatusCode)
	}
	return nil
}
