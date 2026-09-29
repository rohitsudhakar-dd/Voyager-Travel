"""Invented static data.

Airports, cities and countries are real (they come from `airportsdata`).
Everything a customer could mistake for a brand -- airlines, hotels, aircraft
families, card brands -- is invented here, per README.md § 12.
"""

from __future__ import annotations

# ---------------------------------------------------------------- airlines --

ALLIANCES = ("Meridian Alliance", "Skyward Pact", "Global Wing", None)

# (iata_code, name, alliance). Forty fictional carriers. The two-letter codes
# are arbitrary identifiers; the names, and later the generated monogram
# "logos", are ours.
AIRLINES: tuple[tuple[str, str, str | None], ...] = (
    ("VY", "Vega Air", "Meridian Alliance"),
    ("AT", "Atlas Continental", "Meridian Alliance"),
    ("NX", "Nimbus Express", "Skyward Pact"),
    ("QD", "Quadrant Airways", "Global Wing"),
    ("ZE", "Zenith Air", "Meridian Alliance"),
    ("KV", "Kestrel Airlines", "Skyward Pact"),
    ("OR", "Orion Atlantic", "Global Wing"),
    ("PB", "Polaris Blue", "Meridian Alliance"),
    ("HL", "Helios Airways", None),
    ("MR", "Meridian Air", "Meridian Alliance"),
    ("CB", "Cobalt Air", "Skyward Pact"),
    ("SF", "Solstice Airways", None),
    ("AU", "Aurora Nordic", "Skyward Pact"),
    ("BX", "Borealis Air", "Global Wing"),
    ("TE", "Tempest Airlines", None),
    ("LN", "Lumen Air", "Meridian Alliance"),
    ("CR", "Cirrus Continental", "Global Wing"),
    ("GV", "Grandview Air", None),
    ("HV", "Harbour Wing", "Skyward Pact"),
    ("IR", "Iris Airways", None),
    ("JD", "Jade Pacific", "Global Wing"),
    ("KM", "Karst Air", None),
    ("LT", "Lattice Air", "Skyward Pact"),
    ("MO", "Monsoon Airways", "Global Wing"),
    ("NV", "Novara Air", None),
    ("OB", "Obsidian Air", "Meridian Alliance"),
    ("PN", "Pinnacle Air", "Skyward Pact"),
    ("QU", "Quartz Airways", None),
    ("RV", "Riverine Air", "Global Wing"),
    ("SB", "Sable Air", None),
    ("TN", "Titan Nordic", "Skyward Pact"),
    ("UV", "Umbra Air", None),
    ("VD", "Verdant Air", "Meridian Alliance"),
    ("WX", "Westward Air", "Global Wing"),
    ("XN", "Xenon Air", None),
    ("YB", "Yonder Air", "Skyward Pact"),
    ("ZP", "Zephyr Pacific", "Global Wing"),
    ("AK", "Alpine Crest", None),
    ("BD", "Bluedelta Air", "Meridian Alliance"),
    ("CN", "Coral Nine", "Skyward Pact"),
)

# Invented aircraft families, so no manufacturer's product names appear.
NARROWBODY_AIRCRAFT = ("Halcyon 200", "Halcyon 300", "Corvus 500")
WIDEBODY_AIRCRAFT = ("Corvus 700", "Aquila 800", "Aquila 900")


# ------------------------------------------------------------ fare classes --

# (code, cabin, name, refundable, changeable, baggage_included, points_multiplier)
FARE_CLASSES: tuple[tuple[str, str, str, bool, bool, int, str], ...] = (
    ("ECOLITE", "economy", "Economy Lite", False, False, 0, "0.50"),
    ("ECOSAVER", "economy", "Economy Saver", False, True, 1, "0.75"),
    ("ECOSTD", "economy", "Economy Standard", False, True, 1, "1.00"),
    ("ECOFLEX", "economy", "Economy Flex", True, True, 2, "1.25"),
    ("PLUSSTD", "economy_plus", "Premium Standard", False, True, 2, "1.50"),
    ("PLUSFLEX", "economy_plus", "Premium Flex", True, True, 2, "1.75"),
    ("BIZSAVER", "business", "Business Saver", False, True, 2, "2.00"),
    ("BIZSTD", "business", "Business Standard", True, True, 3, "2.50"),
    ("BIZFLEX", "business", "Business Flex", True, True, 3, "3.00"),
    ("FIRSTSTD", "first", "First", True, True, 3, "4.00"),
    ("FIRSTFLEX", "first", "First Flex", True, True, 4, "5.00"),
    ("FIRSTRES", "first", "First Residence", True, True, 4, "6.00"),
)

CABIN_PRICE_MULTIPLIER = {
    "economy": 1.0,
    "economy_plus": 1.6,
    "business": 3.4,
    "first": 6.2,
}

FARE_CLASS_PRICE_MULTIPLIER = {
    "ECOLITE": 0.82,
    "ECOSAVER": 0.92,
    "ECOSTD": 1.00,
    "ECOFLEX": 1.18,
    "PLUSSTD": 1.00,
    "PLUSFLEX": 1.22,
    "BIZSAVER": 0.90,
    "BIZSTD": 1.00,
    "BIZFLEX": 1.20,
    "FIRSTSTD": 1.00,
    "FIRSTFLEX": 1.18,
    "FIRSTRES": 1.45,
}


# -------------------------------------------------------------------- fares --

# Route patterns the fare rules are written against. pricing-service compiles
# these as regular expressions; in the hot path it compiles them per offer,
# which is the whole point of the profiling demo (05-FUNCTIONALITY.md § 7.1).
ROUTE_PATTERN_TEMPLATES = (
    "{origin}-{destination}",
    "{origin}-*",
    "*-{destination}",
    "{origin_region}-{destination_region}",
    "*-*",
)

FARE_RULE_CONDITION_KEYS = (
    "weekend_surcharge",
    "peak_season",
    "corporate_discount",
    "promo_eligible",
    "blackout",
)


# -------------------------------------------------------------------- trunk --

# The routes the demo actually flies. Searching any of these returns a healthy
# page of results, which matters because "LHR to JFK" is the first thing anyone
# types (06-USER-FLOWS.md § 3).
TRUNK_AIRPORTS = (
    "LHR", "JFK", "CDG", "AMS", "FRA", "MAD", "BCN", "FCO", "MUC", "ZRH",
    "DUB", "LIS", "CPH", "ARN", "OSL", "HEL", "VIE", "PRG", "WAW", "IST",
    "DXB", "DOH", "SIN", "HKG", "NRT", "ICN", "SYD", "MEL", "BOM", "DEL",
    "LAX", "SFO", "ORD", "MIA", "BOS", "SEA", "YYZ", "YVR", "GRU", "EZE",
    "JNB", "CAI", "NBO", "BKK", "KUL", "AKL", "ATH", "EDI", "MAN", "BRU",
)

# Cabin mix used when generating historical bookings.
CABIN_WEIGHTS = (("economy", 0.74), ("economy_plus", 0.15),
                 ("business", 0.10), ("first", 0.01))


# ------------------------------------------------------------------ hotels --

HOTEL_BRANDS = (
    "Aster", "Belmont Court", "Cedarline", "Dovecote", "Ellery",
    "Fernbank", "Grayson", "Harrowgate", "Ivywell", "Juniper House",
    "Kingsmere", "Lanternfield", "Marrow & Co", "Northgate", "Oriel",
    "Pemberly", "Quillon", "Rosslyn", "Stonebrook", "Thistledown",
    "Upperton", "Veranda", "Westmoor", "Yarrow", "Zephyrine",
)

HOTEL_SUFFIXES = (
    "Hotel", "Residences", "Suites", "Inn", "House", "Lodge",
    "Hotel & Spa", "Boutique Hotel", "Grand Hotel", "Apartments",
)

HOTEL_AMENITIES = (
    "wifi", "breakfast", "pool", "gym", "spa", "parking", "bar",
    "restaurant", "air_conditioning", "pet_friendly", "airport_shuttle",
    "business_centre", "laundry", "room_service", "ev_charging",
)

NEIGHBORHOOD_PREFIXES = (
    "Old Town", "Riverside", "Harbour", "Central", "Northside", "Southbank",
    "Garden District", "Cathedral Quarter", "Marina", "University Quarter",
    "Financial District", "Arts Quarter",
)

ROOM_TYPES = (
    ("Standard Double", 2, "1 double bed", 22),
    ("Standard Twin", 2, "2 single beds", 24),
    ("Superior Double", 2, "1 king bed", 28),
    ("Deluxe King", 3, "1 king bed + sofa bed", 34),
    ("Junior Suite", 3, "1 king bed + living area", 42),
    ("Family Room", 4, "1 double + 2 singles", 46),
    ("Executive Suite", 4, "1 king bed + separate lounge", 58),
)

RATE_PLAN_TEMPLATES = (
    ("Non-refundable", False, False, 0, 0.86),
    ("Saver", False, True, 24, 0.94),
    ("Flexible", False, True, 48, 1.00),
    ("Bed & Breakfast", True, True, 24, 1.12),
    ("Half Board", True, True, 48, 1.30),
)


# ------------------------------------------------------------------ people --

FIRST_NAMES = (
    "Ava", "Noah", "Maya", "Liam", "Zara", "Ethan", "Iris", "Omar", "Nora",
    "Felix", "Priya", "Hugo", "Leila", "Marcus", "Sofia", "Arjun", "Elena",
    "Theo", "Amara", "Jonas", "Ruby", "Kenji", "Freya", "Diego", "Anika",
    "Caleb", "Yuki", "Rosa", "Samir", "Hannah", "Tobias", "Imani", "Lucas",
    "Mei", "Gabriel", "Sana", "Victor", "Alba", "Idris", "Clara", "Mateo",
    "Nadia", "Oscar", "Lena", "Rafael", "Greta", "Hassan", "Cleo", "Dmitri",
    "Esme", "Anton", "Thandi", "Pierre", "Ingrid", "Rohan", "Beatrix",
    "Sven", "Amelie", "Kwame", "Juliet", "Milo", "Saoirse", "Andre", "Talia",
    "Bruno", "Wren", "Otto", "Helena", "Nikolai", "Joelle", "Ravi", "Astrid",
    "Malik", "Constance", "Emilio", "Paloma", "Bjorn", "Suri", "Aldo", "Vera",
)

LAST_NAMES = (
    "Mitchell", "Okafor", "Lindqvist", "Ferreira", "Nakamura", "Duval",
    "Halvorsen", "Castellano", "Petrov", "Osei", "Rasmussen", "Marchetti",
    "Bergstrom", "Delacroix", "Varga", "Sorensen", "Moretti", "Novak",
    "Kaur", "Andersen", "Whitfield", "Brennan", "Kowalski", "Ibrahim",
    "Lindgren", "Rossi", "Fontaine", "Kimura", "Alvarez", "Haugen",
    "Cavendish", "Dubois", "Eriksen", "Farrow", "Grimaldi", "Hollis",
    "Iqbal", "Jansen", "Kirkland", "Lombardi", "Mbeki", "Nieminen",
    "Ortega", "Pemberton", "Quinlan", "Rahman", "Sandoval", "Tanaka",
    "Ueda", "Vasquez", "Wallace", "Xiang", "Yilmaz", "Zielinski",
    "Ashworth", "Boucher", "Calderon", "Drummond", "Engberg", "Fitzgerald",
    "Gallagher", "Hartmann", "Ivanova", "Jovanovic", "Kristensen", "Laurent",
    "Maguire", "Nystrom", "Oyelaran", "Pedersen", "Radcliffe", "Sinclair",
    "Thorne", "Underhill", "Volkov", "Wexford", "Yamada", "Zaharia",
)

TITLES = ("Mr", "Ms", "Mrs", "Dr", "Mx")

NATIONALITIES = (
    "GB", "US", "FR", "DE", "ES", "IT", "NL", "SE", "NO", "DK", "IE", "PT",
    "PL", "CZ", "AT", "CH", "BE", "FI", "GR", "TR", "AE", "SG", "JP", "KR",
    "AU", "NZ", "CA", "BR", "AR", "ZA", "KE", "IN", "MY", "TH",
)

TIERS = ("standard", "silver", "gold", "platinum")
TIER_WEIGHTS = (0.62, 0.23, 0.11, 0.04)

SIGNUP_COHORTS = (
    "organic", "paid_search", "referral", "affiliate", "social", "email",
)

LOCALES = ("en-GB", "en-US", "fr-FR", "de-DE", "es-ES", "it-IT", "nl-NL")


# ---------------------------------------------------------------- payments --

# Invented card brands. Real card-scheme names are brands like any other, and
# the UI's IIN detection maps first digits onto these.
CARD_BRANDS = ("meridian", "cobalt", "summit", "orbit")
CARD_BRAND_BY_IIN = {"4": "meridian", "5": "cobalt", "3": "summit", "6": "orbit"}

# Exactly the five codes from 05-FUNCTIONALITY.md § 5.2. No others may appear.
DECLINE_CODES = (
    "card_declined",
    "insufficient_funds",
    "expired_card",
    "do_not_honor",
    "fraud_suspected",
)
DECLINE_CODE_WEIGHTS = (0.34, 0.28, 0.16, 0.14, 0.08)

DECLINE_MESSAGES = {
    "card_declined": "Your card was declined. Please try another payment method.",
    "insufficient_funds": "Your card has insufficient funds.",
    "expired_card": "Your card has expired.",
    "do_not_honor": "Your bank declined this payment.",
    "fraud_suspected": "This payment was flagged by your bank.",
}


# ----------------------------------------------------------------- support --

SUPPORT_INTENTS = (
    "booking_lookup",
    "cancellation_policy",
    "change_request",
    "baggage_query",
    "refund_status",
    "general",
)

SUPPORT_OPENERS = {
    "booking_lookup": "Where is my booking {pnr}?",
    "cancellation_policy": "What is the cancellation policy on {pnr}?",
    "change_request": "Can I change the dates on {pnr}?",
    "baggage_query": "How much baggage is included on {pnr}?",
    "refund_status": "When will the refund for {pnr} arrive?",
    "general": "Do I need a visa for this trip?",
}

CANCELLATION_REASONS = (
    "user_cancelled",
    "schedule_change",
    "duplicate_booking",
    "travel_plans_changed",
    "price_dispute",
)
