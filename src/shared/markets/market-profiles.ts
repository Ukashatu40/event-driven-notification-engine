// src/shared/markets/market-profiles.ts

/**
 * Market profiles: everything that differs between the markets the engine
 * serves — currency, regulator, DND registry, SMS providers, trading hours,
 * languages. The engine's logic is market-agnostic; a user's `market` selects
 * the profile. India (IN) remains the default so existing behaviour and the
 * assessment contract are unchanged.
 */
export type MarketCode = 'IN' | 'NG';

export interface MarketProfile {
  code: MarketCode;
  name: string;
  currency: 'INR' | 'NGN';
  currencySymbol: string;
  /** Name of the minor unit: costs are stored as integer minor units. */
  minorUnit: 'paisa' | 'kobo';
  dialCode: string;
  /** Default IANA timezone for new users in this market. */
  timezone: string;
  defaultLanguage: string;
  languages: string[];
  telecomRegulator: string;
  /** Do-Not-Disturb registry SMS is scrubbed against. */
  dndRegistry: string;
  securitiesRegulator: string;
  /** SMS providers in priority order (primary, then failover). */
  smsProviders: [primary: string, fallback: string];
  /** Cash-equity trading session, local time (HH:MM). */
  tradingHours: { open: string; close: string };
}

export const MARKET_PROFILES: Record<MarketCode, MarketProfile> = {
  IN: {
    code: 'IN',
    name: 'India',
    currency: 'INR',
    currencySymbol: '₹',
    minorUnit: 'paisa',
    dialCode: '+91',
    timezone: 'Asia/Kolkata',
    defaultLanguage: 'en',
    languages: ['en', 'hi', 'mr', 'ta', 'te'],
    telecomRegulator: 'TRAI',
    dndRegistry: 'TRAI NCPR (National Do Not Call Registry)',
    securitiesRegulator: 'SEBI',
    smsProviders: ['msg91', 'twilio'],
    tradingHours: { open: '09:15', close: '15:30' },
  },
  NG: {
    code: 'NG',
    name: 'Nigeria',
    currency: 'NGN',
    currencySymbol: '₦',
    minorUnit: 'kobo',
    dialCode: '+234',
    timezone: 'Africa/Lagos',
    defaultLanguage: 'en',
    // English plus Nigerian Pidgin, Hausa, Yoruba and Igbo.
    languages: ['en', 'pcm', 'ha', 'yo', 'ig'],
    telecomRegulator: 'NCC',
    dndRegistry: 'NCC National DND Registry',
    securitiesRegulator: 'SEC Nigeria',
    smsProviders: ['termii', 'twilio'],
    // NGX cash-equity session; verify against the current NGX calendar.
    tradingHours: { open: '10:00', close: '14:30' },
  },
};

export function getMarketProfile(code?: string | null): MarketProfile {
  return MARKET_PROFILES[(code as MarketCode) ?? 'IN'] ?? MARKET_PROFILES.IN;
}
