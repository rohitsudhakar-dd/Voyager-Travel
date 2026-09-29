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
	// Kind is the class name from the § 13.1 hierarchy.
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

func InvalidPricingRequest(message string) *Error {
	return newError("ValidationError", "invalid_request", message, http.StatusBadRequest)
}

func BatchTooLarge(max int) *Error {
	return newError("ValidationError", "batch_too_large",
		"Too many offers in one pricing request.", http.StatusBadRequest).
		WithDetails(map[string]any{"maxOffers": max})
}

func DatabaseError(err error) *Error {
	return newError("DatabaseError", "database_unavailable",
		"A downstream datastore is unavailable.", http.StatusServiceUnavailable).
		WithCause(err)
}

func Internal(err error) *Error {
	return newError("VoyagerError", "internal_error",
		"Something went wrong. Please try again.", http.StatusInternalServerError).
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
