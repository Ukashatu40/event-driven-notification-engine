// src/shared/utils/currency.util.ts

/**
 * Currency and number formatting utilities.
 * Handles Indian number format (₹1,00,000) vs international ($100,000).
 */

export type SupportedLocale =
  | 'en'
  | 'hi'
  | 'mr'
  | 'ta'
  | 'te'
  // Nigerian languages: Pidgin, Hausa, Yoruba, Igbo
  | 'pcm'
  | 'ha'
  | 'yo'
  | 'ig';

export type CurrencyCode = 'INR' | 'NGN';

const LOCALE_MAP: Record<SupportedLocale, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  mr: 'mr-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  // Nigerian Pidgin has no CLDR locale of its own; en-NG gives the correct
  // Nigerian number grouping (1,000,000) and ₦ symbol.
  pcm: 'en-NG',
  ha: 'ha-NG',
  yo: 'yo-NG',
  ig: 'ig-NG',
};

/**
 * Formats a major-unit amount (rupees / naira). English text in an
 * NGN context uses en-NG so ₦ amounts get Nigerian grouping, not lakh grouping.
 */
export function formatCurrency(
  amount: number,
  locale: SupportedLocale = 'en',
  currency: CurrencyCode = 'INR',
): string {
  const intlLocale =
    currency === 'NGN' && locale === 'en' ? 'en-NG' : LOCALE_MAP[locale];

  return new Intl.NumberFormat(intlLocale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatNumber(
  value: number,
  locale: SupportedLocale = 'en',
): string {
  const intlLocale = LOCALE_MAP[locale];
  return new Intl.NumberFormat(intlLocale).format(value);
}

export function paisaToRupees(paisa: number): number {
  return paisa / 100;
}

export function rupeesToPaisa(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Formats integer minor units (paisa or kobo — both are 1/100). */
export function formatPaisa(
  paisa: number,
  locale: SupportedLocale = 'en',
  currency: CurrencyCode = 'INR',
): string {
  return formatCurrency(paisaToRupees(paisa), locale, currency);
}
