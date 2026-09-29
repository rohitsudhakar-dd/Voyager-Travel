import type { Airline, Airport, City } from '@voyager/shared-schemas';

/**
 * Reference data for the fixture layer. Airports and cities are real places --
 * they are not brands, and the demo script in 06-USER-FLOWS.md uses LHR → JFK.
 * Every *carrier* is invented, as are the hotel names generated from these.
 */

export const AIRPORTS: Airport[] = [
  {
    iataCode: 'LHR',
    name: 'Heathrow',
    cityName: 'London',
    countryCode: 'GB',
    timezone: 'Europe/London',
  },
  {
    iataCode: 'LGW',
    name: 'Gatwick',
    cityName: 'London',
    countryCode: 'GB',
    timezone: 'Europe/London',
  },
  {
    iataCode: 'MAN',
    name: 'Manchester',
    cityName: 'Manchester',
    countryCode: 'GB',
    timezone: 'Europe/London',
  },
  {
    iataCode: 'EDI',
    name: 'Edinburgh',
    cityName: 'Edinburgh',
    countryCode: 'GB',
    timezone: 'Europe/London',
  },
  {
    iataCode: 'DUB',
    name: 'Dublin',
    cityName: 'Dublin',
    countryCode: 'IE',
    timezone: 'Europe/Dublin',
  },
  {
    iataCode: 'CDG',
    name: 'Charles de Gaulle',
    cityName: 'Paris',
    countryCode: 'FR',
    timezone: 'Europe/Paris',
  },
  {
    iataCode: 'AMS',
    name: 'Schiphol',
    cityName: 'Amsterdam',
    countryCode: 'NL',
    timezone: 'Europe/Amsterdam',
  },
  {
    iataCode: 'FRA',
    name: 'Frankfurt',
    cityName: 'Frankfurt',
    countryCode: 'DE',
    timezone: 'Europe/Berlin',
  },
  {
    iataCode: 'MUC',
    name: 'Munich',
    cityName: 'Munich',
    countryCode: 'DE',
    timezone: 'Europe/Berlin',
  },
  {
    iataCode: 'BCN',
    name: 'El Prat',
    cityName: 'Barcelona',
    countryCode: 'ES',
    timezone: 'Europe/Madrid',
  },
  {
    iataCode: 'MAD',
    name: 'Barajas',
    cityName: 'Madrid',
    countryCode: 'ES',
    timezone: 'Europe/Madrid',
  },
  {
    iataCode: 'LIS',
    name: 'Humberto Delgado',
    cityName: 'Lisbon',
    countryCode: 'PT',
    timezone: 'Europe/Lisbon',
  },
  {
    iataCode: 'FCO',
    name: 'Fiumicino',
    cityName: 'Rome',
    countryCode: 'IT',
    timezone: 'Europe/Rome',
  },
  {
    iataCode: 'MXP',
    name: 'Malpensa',
    cityName: 'Milan',
    countryCode: 'IT',
    timezone: 'Europe/Rome',
  },
  {
    iataCode: 'ATH',
    name: 'Athens',
    cityName: 'Athens',
    countryCode: 'GR',
    timezone: 'Europe/Athens',
  },
  {
    iataCode: 'IST',
    name: 'Istanbul',
    cityName: 'Istanbul',
    countryCode: 'TR',
    timezone: 'Europe/Istanbul',
  },
  {
    iataCode: 'JFK',
    name: 'John F. Kennedy',
    cityName: 'New York',
    countryCode: 'US',
    timezone: 'America/New_York',
  },
  {
    iataCode: 'EWR',
    name: 'Newark',
    cityName: 'New York',
    countryCode: 'US',
    timezone: 'America/New_York',
  },
  {
    iataCode: 'BOS',
    name: 'Logan',
    cityName: 'Boston',
    countryCode: 'US',
    timezone: 'America/New_York',
  },
  {
    iataCode: 'ORD',
    name: "O'Hare",
    cityName: 'Chicago',
    countryCode: 'US',
    timezone: 'America/Chicago',
  },
  {
    iataCode: 'LAX',
    name: 'Los Angeles',
    cityName: 'Los Angeles',
    countryCode: 'US',
    timezone: 'America/Los_Angeles',
  },
  {
    iataCode: 'SFO',
    name: 'San Francisco',
    cityName: 'San Francisco',
    countryCode: 'US',
    timezone: 'America/Los_Angeles',
  },
  {
    iataCode: 'YYZ',
    name: 'Pearson',
    cityName: 'Toronto',
    countryCode: 'CA',
    timezone: 'America/Toronto',
  },
  { iataCode: 'DXB', name: 'Dubai', cityName: 'Dubai', countryCode: 'AE', timezone: 'Asia/Dubai' },
  {
    iataCode: 'SIN',
    name: 'Changi',
    cityName: 'Singapore',
    countryCode: 'SG',
    timezone: 'Asia/Singapore',
  },
  { iataCode: 'HND', name: 'Haneda', cityName: 'Tokyo', countryCode: 'JP', timezone: 'Asia/Tokyo' },
  {
    iataCode: 'SYD',
    name: 'Kingsford Smith',
    cityName: 'Sydney',
    countryCode: 'AU',
    timezone: 'Australia/Sydney',
  },
  {
    iataCode: 'CPT',
    name: 'Cape Town',
    cityName: 'Cape Town',
    countryCode: 'ZA',
    timezone: 'Africa/Johannesburg',
  },
];

export const CITIES: City[] = [
  'London,GB',
  'Paris,FR',
  'Amsterdam,NL',
  'Barcelona,ES',
  'Madrid,ES',
  'Lisbon,PT',
  'Rome,IT',
  'Milan,IT',
  'Athens,GR',
  'Istanbul,TR',
  'Berlin,DE',
  'Copenhagen,DK',
  'New York,US',
  'Boston,US',
  'Chicago,US',
  'San Francisco,US',
  'Toronto,CA',
  'Dubai,AE',
  'Singapore,SG',
  'Tokyo,JP',
  'Sydney,AU',
  'Cape Town,ZA',
].map((entry, index) => {
  const [name, countryCode] = entry.split(',');
  return { id: index + 1, name, countryCode, region: null, popularityRank: index + 1 };
});

/** Invented carriers. No real airline's name, code pairing or livery. */
export const AIRLINES: Airline[] = [
  { iataCode: 'VG', name: 'Voyager Air', alliance: 'Meridian Alliance', logoSeed: 1 },
  { iataCode: 'NW', name: 'Northwind Airways', alliance: 'Meridian Alliance', logoSeed: 2 },
  { iataCode: 'KE', name: 'Kestrel Air', alliance: 'Meridian Alliance', logoSeed: 3 },
  { iataCode: 'SB', name: 'Sable Atlantic', alliance: 'Compass Group', logoSeed: 4 },
  { iataCode: 'AR', name: 'Aurora Nordic', alliance: 'Compass Group', logoSeed: 5 },
  { iataCode: 'CI', name: 'Cinder Express', alliance: null, logoSeed: 6 },
  { iataCode: 'TQ', name: 'Tessera Airlines', alliance: 'Compass Group', logoSeed: 7 },
  { iataCode: 'HV', name: 'Halcyon Airways', alliance: null, logoSeed: 8 },
];

/** The four simulated GDS providers from 05-FUNCTIONALITY.md § 5.1. */
export const PROVIDERS = ['AMDS', 'SABR', 'TRVP', 'DRCT'] as const;

export const HOTEL_BRANDS = [
  'The Lantern',
  'Harbourstone',
  'Cobblewell',
  'Mirabel',
  'Quayside',
  'The Ardent',
  'Fernhill',
  'Stillwater',
  'Marlowe House',
  'The Verdant',
  'Ashgrove',
  'Pelican Row',
];

export const HOTEL_SUFFIXES = ['Hotel', 'Residence', 'House', 'Rooms', 'Suites', 'Inn'];

export const NEIGHBOURHOODS: Record<string, string[]> = {
  London: ['Southbank', 'Bloomsbury', 'Shoreditch', 'Kensington', 'Marylebone'],
  Paris: ['Le Marais', 'Latin Quarter', 'Montmartre', 'Saint-Germain'],
  'New York': ['Midtown', 'Lower East Side', 'Brooklyn Heights', 'Chelsea'],
};

export const DEFAULT_NEIGHBOURHOODS = ['Old Town', 'Harbour', 'Central', 'Riverside', 'Parkside'];

export const AMENITIES = [
  'wifi',
  'breakfast',
  'pool',
  'gym',
  'parking',
  'restaurant',
  'air_conditioning',
  'spa',
];

export const AIRCRAFT = ['A320neo', 'A321', 'A350-900', 'B737-8', 'B787-9', 'E195-E2'];

export function airportByCode(code: string): Airport | undefined {
  return AIRPORTS.find((airport) => airport.iataCode === code.toUpperCase());
}

export function airlineByCode(code: string): Airline {
  return AIRLINES.find((airline) => airline.iataCode === code) ?? AIRLINES[0];
}
