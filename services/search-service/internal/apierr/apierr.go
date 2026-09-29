// Package apierr implements the typed error hierarchy and HTTP envelope from
// 05-FUNCTIONALITY.md § 13.
//
// The type names are stable and low-cardinality on purpose: that is what
// makes Error Tracking group them correctly once phase 8 lands.
package apierr

import (
	"encoding/json"
	"net/http"
)

type Error struct {
	Kind    string         `json:"type"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`

	status int
	cause  error
}

func (e *Error) Error() string { return e.Kind + ": " + e.Message }
func (e *Error) Unwrap() error { return e.cause }
func (e *Error) Status() int   { return e.status }

// WithCause attaches the underlying failure. It stays in the log and the
// span; it never reaches the client.
func (e *Error) WithCause(err error) *Error {
	e.cause = err
	return e
}

func (e *Error) WithDetails(details map[string]any) *Error {
	e.Details = details
	return e
}

func newError(kind, code, message string, status int) *Error {
	return &Error{Kind: kind, Code: code, Message: message, status: status}
}

func InvalidSearchCriteria(message string) *Error {
	return newError("InvalidSearchCriteriaError", "invalid_search_criteria",
		message, http.StatusBadRequest)
}

// SearchResultExpired is a 410 rather than a 404: the id was valid, the set
// behind it has simply aged out, and the client should search again rather
// than conclude the id was wrong.
func SearchResultExpired(searchID string) *Error {
	return newError("SearchResultExpiredError", "search_expired",
		"These search results have expired. Please search again.",
		http.StatusGone).
		WithDetails(map[string]any{"searchId": searchID})
}

func ResultNotFound(resultID string) *Error {
	return newError("NotFoundError", "result_not_found",
		"That result is not part of this search.", http.StatusNotFound).
		WithDetails(map[string]any{"resultId": resultID})
}

func GdsUnavailable(err error) *Error {
	return newError("GdsUnavailableError", "gds_unavailable",
		"No availability providers responded. Please try again.",
		http.StatusServiceUnavailable).
		WithCause(err)
}

func CacheError(err error) *Error {
	return newError("CacheError", "cache_unavailable",
		"A downstream datastore is unavailable.",
		http.StatusServiceUnavailable).
		WithCause(err)
}

func PricingUnavailable(err error) *Error {
	return newError("DependencyError", "pricing_unavailable",
		"Prices could not be calculated. Please try again.",
		http.StatusBadGateway).
		WithCause(err)
}

func Internal(err error) *Error {
	return newError("VoyagerError", "internal_error",
		"Something went wrong. Please try again.",
		http.StatusInternalServerError).
		WithCause(err)
}

// Write renders the § 13.2 envelope. traceID is empty until phase 8 wires the
// tracer; the field is present from the start so the shape never changes.
func Write(w http.ResponseWriter, requestID, traceID string, err *Error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(err.status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"type":      err.Kind,
			"code":      err.Code,
			"message":   err.Message,
			"details":   err.Details,
			"requestId": requestID,
			"traceId":   traceID,
		},
	})
}
