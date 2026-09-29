/**
 * Intent classification and the canned-but-varied response families.
 *
 * Keyword matching rather than anything clever: the point of this service is
 * to be a believable, controllable LLM, not to be a good one. Variety comes
 * from several phrasings per family so a demo does not read like a recording.
 */

export type Intent =
  | 'booking_lookup'
  | 'cancellation_policy'
  | 'change_request'
  | 'baggage_query'
  | 'refund_status'
  | 'general';

const KEYWORDS: Array<[Intent, RegExp]> = [
  ['refund_status', /\brefund(ed|s)?\b|money back|reimburse/i],
  ['cancellation_policy', /\bcancel|cancellation|policy|penalt/i],
  ['change_request', /\bchange|reschedul|rebook|move my|different date|amend/i],
  ['baggage_query', /\bbag(gage|s)?\b|luggage|suitcase|carry.?on|checked bag/i],
  ['booking_lookup', /\bbooking|reservation|itinerary|pnr|confirmation|my flight/i],
];

export function classify(text: string): Intent {
  for (const [intent, pattern] of KEYWORDS) {
    if (pattern.test(text)) return intent;
  }
  return 'general';
}

/** The tool the model reaches for first, when the caller offers tools. */
export const PREFERRED_TOOL: Record<Intent, string | null> = {
  booking_lookup: 'lookup_booking',
  cancellation_policy: 'get_cancellation_policy',
  change_request: 'lookup_booking',
  baggage_query: 'lookup_booking',
  refund_status: 'lookup_booking',
  general: null,
};

const PNR_PATTERN = /\b([A-HJ-NP-Z2-9]{6})\b/;
// The longest alternative first, and the optional " is" applied after all of
// them. Ordered the other way, "my last name is Lovelace" matches the bare
// `name`, then captures "is" as the surname.
const LAST_NAME_PATTERN =
  /(?:last\s+name|surname|name)(?:\s+is)?[:\s]+([A-Za-z][A-Za-z'-]+)/i;
const BOOKING_ID_PATTERN = /\b(?:booking(?:[ _-]?id)?)[:\s]+([0-9a-f-]{8,36})\b/i;

/** Pull whatever the tool call needs out of the user's own words. */
export function extractArguments(tool: string, text: string): Record<string, unknown> {
  const pnr = PNR_PATTERN.exec(text)?.[1];
  const lastName = LAST_NAME_PATTERN.exec(text)?.[1];
  const bookingId = BOOKING_ID_PATTERN.exec(text)?.[1];

  switch (tool) {
    case 'lookup_booking':
      return { pnr: pnr ?? null, lastName: lastName ?? null };
    case 'get_cancellation_policy':
    case 'initiate_cancellation':
      return { bookingId: bookingId ?? pnr ?? null };
    case 'get_loyalty_balance':
      return {};
    default:
      return {};
  }
}

/**
 * Whether the user has clearly agreed to something. The real gate lives in
 * ai-support-service's tool handler -- a prompt-only guard is a demo waiting
 * to embarrass you -- but the model should still only ask once.
 */
export function isAffirmative(text: string): boolean {
  return /\b(yes|yep|yeah|confirm|go ahead|do it|please cancel|proceed)\b/i.test(text);
}

const RESPONSES: Record<Intent, string[]> = {
  booking_lookup: [
    "I've found your booking. It's confirmed, and the details are shown below. Is there anything on it you'd like me to change?",
    "Here's what I have on file for that reference. Everything looks to be in order — let me know if you'd like me to walk through any part of it.",
    'That reservation is active and confirmed. I can pull up the fare rules or the baggage allowance if either would help.',
  ],
  cancellation_policy: [
    'This fare is refundable up to 24 hours before departure, with a cancellation fee deducted from the refund. After that window it becomes non-refundable, though the taxes are still returned. Would you like me to start a cancellation?',
    "Based on the fare rules on this booking, you can cancel for a partial refund until the day before departure. I can tell you the exact amount you'd get back if you'd like.",
    'Cancellation terms depend on the fare class. On this booking, a fee applies and the remainder is refunded to the original payment method within five to ten business days.',
  ],
  change_request: [
    'I can look at moving that for you. Changes are permitted on this fare for a fee plus any difference in price. Which date did you have in mind?',
    "Happy to help you reschedule. Let me check what's available — could you tell me the new date you'd prefer?",
    "That booking is changeable. There's a change fee and you'd pay the fare difference if the new flight costs more. What dates work for you?",
  ],
  baggage_query: [
    'This fare includes one checked bag up to 23 kg, plus a cabin bag and a personal item. Extra bags can be added before check-in at a lower price than at the airport.',
    "You've got one piece of hold luggage included on this booking. If you need a second, I can add it now and it'll be cheaper than paying at the desk.",
    'Cabin baggage is included on every fare. Checked baggage depends on the fare class — on this one, one bag is included.',
  ],
  refund_status: [
    "Your refund has been approved and sent back to the original payment method. Banks usually take five to ten business days to post it, so it may not have appeared yet.",
    "I can see the refund was processed. It's with your card issuer now, which is the slow part — five to ten business days is typical.",
    'That refund is complete on our side. If it still has not reached you after ten business days, let me know and I will chase it.',
  ],
  general: [
    'Happy to help. Could you tell me a little more about what you need — a booking reference or the date of travel would let me look things up.',
    "I can help with bookings, changes, cancellations, baggage and refunds. What would you like to do?",
    'Of course. If you have your booking reference to hand, I can pull up the details straight away.',
  ],
};

export function pickResponse(intent: Intent): string {
  const family = RESPONSES[intent];
  return family[Math.floor(Math.random() * family.length)];
}

/**
 * `llm_degrade_tools`: prose where a tool call should have been. The answer
 * sounds helpful and does nothing, which is precisely the failure mode that
 * is invisible without output monitoring.
 */
export function degradedResponse(intent: Intent): string {
  const prose: Record<Intent, string> = {
    booking_lookup:
      "You should be able to find your booking by signing in and opening 'My trips'. The reference is in your confirmation email.",
    cancellation_policy:
      'Cancellation terms vary by fare. The full policy is set out in the terms and conditions on our website.',
    change_request:
      "Changes can usually be made through the 'Manage booking' page, subject to the fare rules on your ticket.",
    baggage_query:
      'Baggage allowances depend on the fare you bought. The allowance is printed on your ticket and in the confirmation email.',
    refund_status:
      'Refunds are typically processed within five to ten business days. Your bank statement will show it once it clears.',
    general: 'I can point you in the right direction — our help centre covers most questions.',
  };
  return prose[intent];
}

const FAKE_AIRLINES = ['Halcyon Air', 'Corvus Airways', 'Aquila Atlantic', 'Meridian Jet'];
const FAKE_ROUTES = [
  ['London Heathrow', 'Lisbon'],
  ['Amsterdam', 'Barcelona'],
  ['Dublin', 'Milan Malpensa'],
];

/**
 * `llm_hallucinate`: a fluent, specific, entirely invented itinerary. It must
 * never touch the booking record -- the whole point is that the data is right
 * and only the model's output is wrong.
 */
export function hallucinatedResponse(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pnr = Array.from(
    { length: 6 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join('');
  const airline = FAKE_AIRLINES[Math.floor(Math.random() * FAKE_AIRLINES.length)];
  const [from, to] = FAKE_ROUTES[Math.floor(Math.random() * FAKE_ROUTES.length)];
  const flightNumber = 100 + Math.floor(Math.random() * 800);

  return (
    `I've found it — booking reference ${pnr}. That's ${airline} flight ${flightNumber} ` +
    `from ${from} to ${to}, departing at 14:35 and arriving at 17:10, with seat 14C ` +
    'assigned and one checked bag included. Everything is confirmed and no action is needed.'
  );
}

/** `llm_token_bloat`: the same answer, at four times the length. */
export function bloat(text: string): string {
  return [
    text,
    "To give you the full picture, I should explain how this normally works end to end, because the details do matter and I would rather be thorough than leave you guessing.",
    'The relevant terms are set by the fare conditions attached to your ticket, which are in turn set by the airline at the time of booking, and these vary by route, by cabin, and occasionally by the specific promotion the fare was sold under.',
    'If any of that is unclear, or if your situation differs from the standard case in any way at all, please do say so and I will go through it again in whatever level of detail is most useful to you.',
    'I want to make absolutely sure you have everything you need before we finish, so take your time and ask as many follow-up questions as you like.',
  ].join(' ');
}
