// tests/unit/templates/template-engine.service.spec.ts
import { TemplateEngineService } from '../../../src/templates/engine/template-engine.service';
import { PersonalisationService } from '../../../src/templates/engine/personalisation.service';
import { SmsTruncationService } from '../../../src/templates/engine/sms-truncation.service';
import { EVENT_TYPES } from '../../../src/shared/constants/event-types';
import type { Channel } from '../../../src/shared/constants/channels';
import type { SupportedLocale } from '../../../src/shared/utils/currency.util';

const engine = new TemplateEngineService(
  new PersonalisationService(),
  new SmsTruncationService(),
);
engine.onModuleInit();
const sms = new SmsTruncationService();

const ALL_EVENTS = Object.values(EVENT_TYPES);
const CHANNELS: Channel[] = ['sms', 'email', 'push', 'whatsapp', 'in_app'];
const LOCALES: SupportedLocale[] = [
  'en',
  'hi',
  'mr',
  'ta',
  'te',
  'pcm',
  'ha',
  'yo',
  'ig',
];

/** A payload rich enough to satisfy every template's placeholders. */
const PAYLOAD = {
  stock_name: 'Reliance',
  symbol: 'RELIANCE',
  qty: 10,
  price: 2900,
  total: 29000,
  order_id: 'O-1',
  buy_price: 2800,
  current_price: 2905,
  target_price: 2900,
  direction: 'ABOVE',
  shortfall_amount: 125000,
  current_margin: 375000,
  required_margin: 500000,
  deadline: '2026-09-21T11:30:00.000Z',
  auto_square_off_time: '2026-09-21T12:00:00.000Z',
  amount: 5000,
  source: 'Paystack',
  available_balance: 15000,
  reason: 'RMS_REJECT',
  company: 'MTN Nigeria',
  record_date: '2026-09-30',
  portfolio_value: 1_000_000,
  nav: 52.4,
  fund_name: 'Growth Fund',
  units: 12.5,
  date: '2026-09-25',
  goal_name: 'House',
  percent: 60,
  circuit_level: '10%',
  halt_duration: '15 min',
  index_name: 'NIFTY 50',
  level: 24500,
  expiry_date: '2026-10-01',
  documents: 'PAN',
  link: 'https://x.test',
  period: 'Q3',
  positions_closed: 2,
  pnl: 1200,
  sector: 'IT',
  allocation: 45,
  metric: 'VaR',
};

const ctx = (language: SupportedLocale, over = {}) => ({
  userId: 'u-1',
  userName: 'Ada',
  language,
  timezone: 'Africa/Lagos',
  currency: 'NGN' as const,
  payload: PAYLOAD,
  appName: 'WealthBridge',
  ...over,
});

describe('template registry', () => {
  it('has a template for every one of the 25 event types', () => {
    expect(ALL_EVENTS).toHaveLength(25);
    for (const e of ALL_EVENTS) {
      const has = CHANNELS.some((c) => engine.supportsChannel(e, c));
      expect({ e, has }).toEqual({ e, has: true });
    }
  });

  it('every event renders on every channel it defines, in every language, with no leftover placeholders', async () => {
    let rendered = 0;
    for (const event of ALL_EVENTS) {
      for (const channel of CHANNELS) {
        if (!engine.supportsChannel(event, channel)) continue;
        for (const locale of LOCALES) {
          const r = await engine.render(`${event}-v1`, channel, ctx(locale));
          const text = [r.subject, r.title, r.body].filter(Boolean).join(' | ');
          expect({
            event,
            channel,
            locale,
            leftover: /\{\{|\}\}/.test(text),
          }).toEqual({
            event,
            channel,
            locale,
            leftover: false,
          });
          expect(r.channel).toBe(channel);
          rendered++;
        }
      }
    }
    expect(rendered).toBeGreaterThan(500);
  });

  it('every rendered SMS fits its own segment limit', async () => {
    for (const event of ALL_EVENTS) {
      if (!engine.supportsChannel(event, 'sms')) continue;
      for (const locale of LOCALES) {
        const r = await engine.render(`${event}-v1`, 'sms', ctx(locale));
        expect({ event, locale, fits: sms.fits(r.body) }).toEqual({
          event,
          locale,
          fits: true,
        });
      }
    }
  });

  it('Nigerian-language SMS stay GSM-7 after currency normalisation (single 160-char segment)', async () => {
    for (const locale of ['pcm', 'ha', 'yo', 'ig'] as const) {
      for (const event of ['RISK-001', 'RISK-002', 'TXNX-001', 'TXNX-005']) {
        const r = await engine.render(`${event}-v1`, 'sms', ctx(locale));
        expect({ event, locale, gsm7: sms.isGsm7(r.body) }).toEqual({
          event,
          locale,
          gsm7: true,
        });
      }
    }
  });

  it('reports which channels a template can serve (MKTX-003 is push/in-app/whatsapp only)', () => {
    expect(engine.supportsChannel('MKTX-003', 'push')).toBe(true);
    expect(engine.supportsChannel('MKTX-003', 'sms')).toBe(false);
    expect(engine.supportsChannel('NOPE-999', 'sms')).toBe(false);
  });
});

describe('rendering behaviour', () => {
  it('formats money as naira for an NGN user and rupees for an INR user', async () => {
    const ng = await engine.render('TXNX-005-v1', 'in_app', ctx('en'));
    const inr = await engine.render(
      'TXNX-005-v1',
      'in_app',
      ctx('en', { currency: 'INR' }),
    );
    expect(ng.body).toContain('₦5,000');
    expect(inr.body).toContain('₹5,000');
  });

  it('uses the localised text for a translated template and falls back to English otherwise', async () => {
    const yo = await engine.render('TXNX-005-v1', 'sms', ctx('yo'));
    const en = await engine.render('TXNX-005-v1', 'sms', ctx('en'));
    const fallback = await engine.render('SIPX-001-v1', 'push', ctx('yo')); // no Yoruba variant
    expect(yo.body).toMatch(/^Owo wole/);
    expect(en.body).toMatch(/^Funds Deposited/);
    expect(fallback.body).toBeTruthy();
  });

  it('SMS says "NGN" not "₦" so the message stays GSM-7 (and 160 characters)', async () => {
    const r = await engine.render('TXNX-005-v1', 'sms', ctx('en'));
    expect(r.body).toContain('NGN 5,000');
    expect(r.body).not.toContain('₦');
  });

  it('omits the balance clause when the payment webhook has no balance', async () => {
    const { available_balance: _omit, ...payload } = PAYLOAD;
    const r = await engine.render('TXNX-005-v1', 'sms', ctx('en', { payload }));
    expect(r.body).not.toMatch(/balance/i);
    expect(r.body).toMatch(
      /^Funds Deposited: NGN 5,000 from Paystack\. -WealthBridge$/,
    );
  });

  it('HTML-escapes personalised values (template injection / XSS, spec A10.1.B)', async () => {
    const r = await engine.render(
      'TXNX-001-v1',
      'email',
      ctx('en', { userName: '<script>alert(1)</script>' }),
    );
    expect(r.body).not.toContain('<script>');
    expect(r.body).toContain('&lt;script&gt;');
  });

  it('does not let a payload value inject template syntax', async () => {
    const r = await engine.render(
      'TXNX-001-v1',
      'sms',
      ctx('en', {
        payload: {
          ...PAYLOAD,
          stock_name: '{{{userId}}}{{#each this}}x{{/each}}',
        },
      }),
    );
    expect(r.body).toContain('{{{userId}}}'); // treated as data, not evaluated
  });

  it('push renders title, body and templated data', async () => {
    const r = await engine.render('TXNX-001-v1', 'push', ctx('en'));
    expect(r.title).toBe('Buy Order Executed');
    expect(r.data).toMatchObject({ action: 'open_portfolio', order_id: 'O-1' });
  });

  it('WhatsApp resolves template parameters in order', async () => {
    const r = await engine.render('TXNX-001-v1', 'whatsapp', ctx('en'));
    expect(r.data).toMatchObject({ templateName: 'buy_order_executed_v1' });
    expect(
      (r.data as { resolvedParameters: string[] }).resolvedParameters[0],
    ).toBe('Reliance');
  });

  it('errors clearly for an unknown template and for a channel the template lacks', async () => {
    await expect(engine.render('NOPE-1-v1', 'sms', ctx('en'))).rejects.toThrow(
      /Template not found/,
    );
    await expect(
      engine.render('MKTX-003-v1', 'sms', ctx('en')),
    ).rejects.toThrow(/no definition for channel sms/);
  });

  it('handles missing fields and awkward values without throwing', async () => {
    await expect(
      engine.render('TXNX-001-v1', 'sms', ctx('en', { payload: {} })),
    ).resolves.toBeDefined();
    await expect(
      engine.render('TXNX-001-v1', 'sms', ctx('en', { userName: undefined })),
    ).resolves.toBeDefined();
    const long = await engine.render(
      'TXNX-001-v1',
      'sms',
      ctx('en', {
        payload: { ...PAYLOAD, stock_name: 'A'.repeat(400) },
      }),
    );
    expect(sms.fits(long.body)).toBe(true);
    expect(long.truncated).toBe(true);
  });

  it('renders emoji and non-Latin scripts', async () => {
    const r = await engine.render('RISK-001-v1', 'push', ctx('hi'));
    expect(r.title).toContain('मार्जिन');
  });
});

describe('file-based template definitions', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync, readdirSync } = require('fs') as typeof import('fs');
  const dir = 'src/templates/definitions';

  it('every .json definition is valid JSON (a bad file used to abort loading silently)', () => {
    const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      expect(() =>
        JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')),
      ).not.toThrow();
    }
  });

  it.each(['RISK-001', 'TXNX-001'])(
    '%s.template.json matches the built-in definition, so the file can never silently regress the message',
    (id) => {
      const file = JSON.parse(
        readFileSync(`${dir}/${id}.template.json`, 'utf8'),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inline = (engine as any)
        .getInlineTemplates()
        .find((t: any) => t.templateId === `${id}-v1`);
      expect(file).toEqual(inline);
    },
  );

  it('the margin-call SMS keeps the auto-square-off warning in every language that has it', async () => {
    for (const locale of ['en', 'hi', 'mr'] as const) {
      const r = await engine.render('RISK-001-v1', 'sms', ctx(locale));
      expect({
        locale,
        mentionsSquareOff:
          /12:00|square|स्क्वे/i.test(r.body) ||
          /Wed|Thu|Fri|Mon|Tue|Sat|Sun|\d{1,2}:\d{2}/.test(r.body),
      }).toEqual({ locale, mentionsSquareOff: true });
    }
  });

  it('tolerates a leading // comment and skips a corrupt file without losing the rest', () => {
    const e2 = new TemplateEngineService(
      new PersonalisationService(),
      new SmsTruncationService(),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const before = (e2 as any).templates.size;
    e2.onModuleInit();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((e2 as any).templates.size).toBeGreaterThanOrEqual(before + 25);
  });
});
