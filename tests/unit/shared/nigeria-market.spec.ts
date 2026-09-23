// tests/unit/shared/nigeria-market.spec.ts
import {
  formatCurrency,
  formatPaisa,
} from '../../../src/shared/utils/currency.util';
import {
  getMarketProfile,
  MARKET_PROFILES,
} from '../../../src/shared/markets/market-profiles';
import { SmsTruncationService } from '../../../src/templates/engine/sms-truncation.service';
import { NG_LOCALISATIONS } from '../../../src/templates/definitions/ng-localisations';
import { PersonalisationService } from '../../../src/templates/engine/personalisation.service';

describe('market profiles', () => {
  it('Nigeria: NGN/kobo, NCC, Termii→Twilio, Lagos, five languages', () => {
    const ng = getMarketProfile('NG');
    expect(ng).toMatchObject({
      currency: 'NGN',
      minorUnit: 'kobo',
      telecomRegulator: 'NCC',
      dialCode: '+234',
      timezone: 'Africa/Lagos',
      smsProviders: ['termii', 'twilio'],
    });
    expect(ng.languages).toEqual(['en', 'pcm', 'ha', 'yo', 'ig']);
  });

  it('India stays the default (existing behaviour unchanged)', () => {
    expect(getMarketProfile(undefined)).toBe(MARKET_PROFILES.IN);
    expect(getMarketProfile('ZZ')).toBe(MARKET_PROFILES.IN);
    expect(MARKET_PROFILES.IN.smsProviders).toEqual(['msg91', 'twilio']);
  });
});

describe('currency formatting', () => {
  it('formats naira with Nigerian grouping (1,000,000 — not lakh)', () => {
    expect(formatCurrency(1234567, 'en', 'NGN')).toBe('₦1,234,567');
  });

  it('keeps Indian lakh grouping for INR by default', () => {
    expect(formatCurrency(1234567, 'en')).toBe('₹12,34,567');
  });

  it('formats kobo minor units', () => {
    expect(formatPaisa(500000, 'en', 'NGN')).toBe('₦5,000');
  });

  it.each(['pcm', 'ha', 'yo', 'ig'] as const)(
    'does not throw for locale %s',
    (l) => {
      expect(formatCurrency(5000, l, 'NGN')).toContain('5,000');
    },
  );
});

describe('personalisation with a Nigerian user', () => {
  it('renders naira amounts', () => {
    const ctx = new PersonalisationService().buildContext({
      userId: 'u',
      language: 'pcm',
      timezone: 'Africa/Lagos',
      currency: 'NGN',
      payload: { amount: 5000 },
    });
    expect(ctx['amount']).toBe('₦5,000');
  });
});

describe('SMS encoding-aware limits', () => {
  const sms = new SmsTruncationService();

  it('160 characters for GSM-7 text (ASCII, Pidgin)', () => {
    expect(sms.limitFor('Money don enter: N5,000')).toBe(160);
  });

  it('70 characters as soon as one non-GSM letter appears (Yoruba ọ, Igbo ị, Hausa ƙ, ₦)', () => {
    for (const text of ['Owó wọlé', 'Ịzụrụ agwụla', 'ƙudi', 'Balance ₦5,000']) {
      expect(sms.isGsm7(text)).toBe(false);
      expect(sms.limitFor(text)).toBe(70);
    }
  });

  it('counts GSM extension characters (€ [ ] { }) as two', () => {
    expect(sms.encodedLength('a[b')).toBe(4);
  });

  it('truncates a long Devanagari message to 70, not 160', () => {
    const out = sms.truncate('खरीद आदेश पूरा '.repeat(10));
    expect(out.length).toBeLessThanOrEqual(70);
  });

  it('leaves a 100-char ASCII message alone but truncates a 100-char Yoruba one', () => {
    expect(sms.truncate('a'.repeat(100))).toHaveLength(100);
    expect(sms.truncate('ọ'.repeat(100)).length).toBeLessThanOrEqual(70);
  });
});

describe('SMS-safe currency', () => {
  const sms = new SmsTruncationService();

  it('naira and rupee signs become ASCII so a 160-char SMS stays 160', () => {
    expect(sms.toSmsSafe('Owo wole: ₦5,000')).toBe('Owo wole: NGN 5,000');
    expect(sms.toSmsSafe('Total ₹1,25,000')).toBe('Total Rs 1,25,000');
    expect(sms.isGsm7(sms.toSmsSafe('Owo wole: ₦5,000'))).toBe(true);
  });

  it('removes the non-breaking spaces Intl inserts (e.g. ha-NG "₦ 20,000")', () => {
    const out = sms.toSmsSafe('₦\u00a020,000');
    expect(out).toBe('NGN 20,000');
    expect(sms.isGsm7(out)).toBe(true);
  });

  it('leaves genuinely non-GSM languages alone (Hindi stays UCS-2)', () => {
    expect(sms.toSmsSafe('खरीद ₹5')).toBe('खरीद Rs 5');
    expect(sms.isGsm7(sms.toSmsSafe('खरीद ₹5'))).toBe(false);
  });
});

describe('Nigerian localisations', () => {
  const locales = ['pcm', 'ha', 'yo', 'ig'];
  const sms = new SmsTruncationService();

  it('cover every locale for each of the four templates', () => {
    for (const t of [
      'RISK-001-v1',
      'RISK-002-v1',
      'TXNX-001-v1',
      'TXNX-005-v1',
    ]) {
      for (const l of locales)
        expect(NG_LOCALISATIONS[t]?.[l]?.['sms']?.['body']).toBeTruthy();
    }
  });

  it('every SMS body is GSM-7 safe, so it stays a single 160-char segment', () => {
    for (const [t, byLocale] of Object.entries(NG_LOCALISATIONS)) {
      for (const [l, ch] of Object.entries(byLocale)) {
        const body = ch['sms']?.['body'] ?? '';
        expect({ t, l, gsm7: sms.isGsm7(body) }).toEqual({ t, l, gsm7: true });
      }
    }
  });

  it('every SMS body keeps the placeholders the English template uses', () => {
    const must: Record<string, string[]> = {
      'RISK-001-v1': [
        '{{shortfall_amount}}',
        '{{deadline}}',
        '{{auto_square_off_time}}',
      ],
      'RISK-002-v1': ['{{shortfall_amount}}', '{{auto_square_off_time}}'],
      'TXNX-001-v1': ['{{stock_name}}', '{{qty}}', '{{price}}', '{{total}}'],
      'TXNX-005-v1': ['{{amount}}', '{{source}}'],
    };
    for (const [t, tokens] of Object.entries(must)) {
      for (const l of locales) {
        const body = NG_LOCALISATIONS[t][l]['sms']['body'];
        for (const token of tokens)
          expect({ t, l, token, has: body.includes(token) }).toEqual({
            t,
            l,
            token,
            has: true,
          });
      }
    }
  });
});
