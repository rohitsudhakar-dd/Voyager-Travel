package rules

import (
	"regexp"
	"sort"
	"strings"
	"time"
)

// Quote is the priced outcome for one offer.
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

// Index is the pre-built lookup: rules grouped by their route pattern, each
// group sorted by descending priority. Built once per reload.
type Index struct {
	byPattern map[string][]Rule
	all       []Rule
}

func BuildIndex(all []Rule) *Index {
	byPattern := make(map[string][]Rule, len(all)/4)
	for _, rule := range all {
		byPattern[rule.RoutePattern] = append(byPattern[rule.RoutePattern], rule)
	}
	for pattern := range byPattern {
		group := byPattern[pattern]
		sort.SliceStable(group, func(i, j int) bool {
			return group[i].Priority > group[j].Priority
		})
	}
	return &Index{byPattern: byPattern, all: all}
}

func (i *Index) Len() int { return len(i.all) }

// Evaluate prices one offer.
//
// hotPath reproduces a real and depressingly common production mistake:
// throwing away the index, scanning every rule, and compiling a regular
// expression inside the loop. For a 50-offer batch against 2,000 rules that
// is 100,000 compilations -- genuine, attributable CPU work the profiler
// will pin on regexp.MustCompile. The audience recognises it, which is the
// entire point (05-FUNCTIONALITY.md § 7.1).
func (i *Index) Evaluate(offer Offer, now time.Time, hotPath bool) Quote {
	var matched []Rule
	evaluated := 0

	if hotPath {
		for _, rule := range i.all {
			evaluated++
			if !regexp.MustCompile(patternToRegex(rule.RoutePattern)).
				MatchString(offer.Origin+"-"+offer.Destination) &&
				!regexp.MustCompile(patternToRegex(rule.RoutePattern)).
					MatchString(offer.OriginRegion+"-"+offer.DestRegion) {
				continue
			}
			if rule.applies(offer, now) {
				matched = append(matched, rule)
			}
		}
		sort.SliceStable(matched, func(a, b int) bool {
			return matched[a].Priority > matched[b].Priority
		})
	} else {
		for _, key := range candidateKeys(offer) {
			for _, rule := range i.byPattern[key] {
				evaluated++
				if rule.applies(offer, now) {
					matched = append(matched, rule)
				}
			}
		}
		// Each group is already sorted, but the five groups are interleaved.
		sort.SliceStable(matched, func(a, b int) bool {
			return matched[a].Priority > matched[b].Priority
		})
	}

	amount := offer.BaseCents
	applied := make([]AppliedRule, 0, len(matched))
	for _, rule := range matched {
		delta := rule.delta(amount)
		amount += delta
		applied = append(applied, AppliedRule{
			ID:         rule.ID,
			Pattern:    rule.RoutePattern,
			Type:       rule.AdjustmentType,
			Value:      rule.AdjustmentValue,
			Priority:   rule.Priority,
			DeltaCents: delta,
		})
	}

	// A stack of discounts must never produce a negative fare.
	if amount < 0 {
		amount = 0
	}

	taxes := int64(float64(amount) * TaxRate)
	return Quote{
		OfferID:          offer.ID,
		BaseCents:        offer.BaseCents,
		AdjustmentsCents: amount - offer.BaseCents,
		TaxesCents:       taxes,
		TotalCents:       amount + taxes,
		Currency:         offer.Currency,
		AppliedRules:     applied,
		RulesEvaluated:   evaluated,
	}
}

func patternToRegex(pattern string) string {
	return "^" + strings.ReplaceAll(regexp.QuoteMeta(pattern), `\*`, ".*") + "$"
}
