// src/templates/engine/personalisation.service.ts
import { Injectable, Logger } from '@nestjs/common';
import {
  formatCurrency,
  formatNumber,
  type SupportedLocale,
} from '../../shared/utils/currency.util';

export interface PersonalisationContext {
  userId: string;
  userName?: string;
  language: SupportedLocale;
  timezone: string;
  payload: Record<string, unknown>;
  appName?: string;
}

/**
 * Personalisation pipeline — goes beyond simple variable substitution.
 *
 * Steps:
 * 1. Resolve user context (name, language, timezone)
 * 2. Compute derived fields (P&L, portfolio impact %, tax)
 * 3. Apply locale-aware formatting (₹1,00,000 vs $100,000)
 * 4. Handle missing fields gracefully (use defaults, never crash)
 */
@Injectable()
export class PersonalisationService {
  private readonly logger = new Logger(PersonalisationService.name);

  buildContext(ctx: PersonalisationContext): Record<string, unknown> {
    this.logger.debug(
      `Building personalisation context for user ${ctx.userId} with payload ${JSON.stringify(ctx.payload)}`,
    );
    const locale = ctx.language;
    const payload = ctx.payload;

    const base: Record<string, unknown> = {
      user_name: ctx.userName ?? 'Valued Customer',
      app_name: ctx.appName ?? 'WealthBridge',
      user_id: ctx.userId,
      timestamp: this.formatTimestamp(new Date(), ctx.timezone),
    };

    // Format all monetary fields in the payload
    const formatted = this.formatMonetaryFields(payload, locale);

    // Compute derived fields
    const derived = this.computeDerivedFields(payload, locale);

    return { ...base, ...formatted, ...derived };
  }

  private formatMonetaryFields(
    payload: Record<string, unknown>,
    locale: SupportedLocale,
  ): Record<string, unknown> {
    const MONETARY_FIELDS = [
      'amount',
      'price',
      'total',
      'shortfall_amount',
      'current_margin',
      'required_margin',
      'portfolio_value',
      'nav',
      'current_value',
      'target_price',
      'current_price',
    ];

    const result: Record<string, unknown> = { ...payload };

    for (const field of MONETARY_FIELDS) {
      const raw = payload[field];
      if (typeof raw === 'number') {
        // Keep raw value for calculations
        result[`${field}_raw`] = raw;
        // Add formatted version for template rendering
        result[field] = formatCurrency(raw, locale);
      }
    }

    return result;
  }

  private computeDerivedFields(
    payload: Record<string, unknown>,
    locale: SupportedLocale,
  ): Record<string, unknown> {
    const derived: Record<string, unknown> = {};

    // P&L calculation
    const buyPrice = payload['buy_price'] as number | undefined;
    const currentPrice = payload['current_price_raw'] as number | undefined;
    const qty = payload['qty'] as number | undefined;

    if (buyPrice && currentPrice && qty) {
      const pnl = (currentPrice - buyPrice) * qty;
      derived['pnl'] = formatCurrency(pnl, locale);
      derived['pnl_raw'] = pnl;
      derived['pnl_percent'] = (
        ((currentPrice - buyPrice) / buyPrice) *
        100
      ).toFixed(2);
      derived['pnl_direction'] = pnl >= 0 ? 'profit' : 'loss';
    }

    // Portfolio impact
    const portfolioValue = payload['portfolio_value_raw'] as number | undefined;
    const tradeValue =
      typeof payload['total_raw'] === 'number'
        ? (payload['total_raw'] as number)
        : undefined;

    if (portfolioValue && tradeValue && portfolioValue > 0) {
      derived['portfolio_impact_percent'] = (
        (tradeValue / portfolioValue) *
        100
      ).toFixed(2);
    }

    // Shortfall percentage for margin calls
    const shortfall = payload['shortfall_amount_raw'] as number | undefined;
    const required = payload['required_margin_raw'] as number | undefined;

    if (shortfall && required && required > 0) {
      derived['shortfall_percent'] = ((shortfall / required) * 100).toFixed(1);
    }

    // Quantity formatting
    if (typeof qty === 'number') {
      derived['qty_formatted'] = formatNumber(qty, locale);
    }

    return derived;
  }

  private formatTimestamp(date: Date, timezone: string): string {
    try {
      return date.toLocaleString('en-IN', {
        timeZone: timezone,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return date.toISOString();
    }
  }
}
