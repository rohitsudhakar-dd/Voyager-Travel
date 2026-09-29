/**
 * ============================================================================
 * THE ONLY FILE IN THIS GENERATOR THAT KNOWS WHAT THE UI LOOKS LIKE.
 * ============================================================================
 *
 * Everything the generator knows about the front end is here -- routes,
 * action names, test ids -- so when the UI moves, this is the one file to
 * read and the one file to correct. Nothing else in the generator may contain
 * a selector string.
 *
 * The two groups are not equally stable, and the difference decides who has
 * to change when they disagree:
 *
 *   ROUTES and ACTIONS are specified. Routes come from 06-USER-FLOWS.md § 2
 *   and `data-dd-action-name` values from § 7. If the UI departs from them,
 *   the UI is wrong: those action names are the RUM taxonomy, and renaming
 *   one silently empties every funnel and dashboard built on it.
 *
 *   TESTIDS are Phase 7's markup, following the kebab-case convention in
 *   04-STYLING.md § 8 but not otherwise specified. If the UI departs from
 *   them, this file is wrong. The generator prefers an action-name selector
 *   wherever § 7 provides one, and falls back to a test id only for the
 *   fields that carry no RUM action, which is most text inputs.
 */

import type { Locator, Page } from 'playwright';

/** Route patterns exactly as 06-USER-FLOWS.md § 2 lists them. */
export const ROUTES = {
  home: '/',
  searchFlights: '/search/flights',
  results: '/results/flights/',
  detail: '/detail/',
  checkoutReview: '/checkout/',
  confirmation: '/confirmation/',
} as const;

/** `data-dd-action-name` values, verbatim from 06-USER-FLOWS.md § 7. */
export const ACTIONS = {
  submitFlightSearch: 'Submit flight search',
  selectAirportSuggestion: 'Select airport suggestion',
  selectFlightResult: 'Select flight result',
  viewFareDetails: 'View fare details',
  submitPassengerDetails: 'Submit passenger details',
  submitPayment: 'Submit payment',
  bookingConfirmed: 'Booking confirmed',
  copyPnr: 'Copy PNR',
} as const;

export const TESTIDS = {
  searchForm: 'flight-search-form',
  searchOrigin: 'search-origin',
  searchDestination: 'search-destination',
  comboboxOption: 'combobox-option',
  departDate: 'search-dates-start',
  dateCell: 'date-cell',
  dateNextMonth: 'date-next-month',
  datePickerDone: 'date-picker-done',
  searchSubmit: 'search-submit',
  flightResultRow: 'flight-result-row',
  flightResultSelect: 'flight-result-select',
  reviewContinue: 'review-continue',
  passengerFirstName: 'passenger-0-first-name',
  passengerLastName: 'passenger-0-last-name',
  passengerDateOfBirth: 'passenger-0-dob',
  passengerNationality: 'passenger-0-nationality',
  contactEmail: 'contact-email',
  contactPhone: 'contact-phone',
  passengersContinue: 'passengers-continue',
  cardHolder: 'card-holder',
  cardNumber: 'card-number',
  cardExpiry: 'card-expiry',
  cardCvc: 'card-cvc',
  paymentSubmit: 'payment-submit',
  confirmation: 'confirmation',
} as const;

export function byAction(page: Page, action: string): Locator {
  return page.locator(`[data-dd-action-name="${action}"]`).first();
}

export function byTestId(page: Page, testId: string): Locator {
  return page.locator(`[data-testid="${testId}"]`).first();
}

/**
 * Matches on either, so a rename on one side does not stop the funnel while
 * the other side still identifies the element.
 */
export function byActionOrTestId(page: Page, action: string, testId: string): Locator {
  return page.locator(`[data-dd-action-name="${action}"], [data-testid="${testId}"]`).first();
}
