// src/shared/utils/currency.util.ts

/**
 * Currency and number formatting utilities.
 * Handles Indian number format (₹1,00,000) vs international ($100,000).
 */

export type SupportedLocale = 'en' | 'hi' | 'mr' | 'ta' | 'te';

const LOCALE_MAP: Record<SupportedLocale, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  mr: 'mr-IN',
  ta: 'ta-IN',
  te: 'te-IN',
};

export function formatCurrency(
  amountInRupees: number,
  locale: SupportedLocale = 'en',
): string {
  const intlLocale = LOCALE_MAP[locale];

  return new Intl.NumberFormat(intlLocale, {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amountInRupees);
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

export function formatPaisa(
  paisa: number,
  locale: SupportedLocale = 'en',
): string {
  return formatCurrency(paisaToRupees(paisa), locale);
}
