// tests/unit/events/event-payload.validator.spec.ts
import {
  EVENT_VALIDATORS,
  validateEvent,
  validateEventPayload,
} from '../../../src/events/validators/event-payload.validator';

const future = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();
const USER = '11111111-1111-4111-8111-111111111111';

const base = (
  eventType: string,
  payload: Record<string, unknown>,
  over = {},
) => ({
  eventType,
  eventId: 'EVT-1',
  sourceSystem: 'test',
  timestamp: new Date().toISOString(),
  priority: 1,
  userId: USER,
  payload,
  ...over,
});

const margin = (over: Record<string, unknown> = {}) => ({
  shortfall_amount: 125000,
  current_margin: 375000,
  required_margin: 500000,
  deadline: future(),
  auto_square_off_time: future(7_200_000),
  ...over,
});

const errorsFor = (e: ReturnType<typeof base>) => validateEvent(e);
const fields = (e: ReturnType<typeof base>) => errorsFor(e).map((x) => x.field);

describe('event envelope validation', () => {
  it('accepts a valid margin call', () => {
    expect(errorsFor(base('RISK-001', margin()))).toEqual([]);
  });

  it.each([
    ['event_id', { eventId: '' }],
    ['source_system', { sourceSystem: '' }],
    ['timestamp', { timestamp: 'yesterday' }],
    ['user_id', { userId: 'not-a-uuid' }],
    ['priority', { priority: 4 }],
  ])('rejects a bad %s and reports it in snake_case', (field, over) => {
    expect(fields(base('RISK-001', margin(), over))).toContain(field);
  });

  it('rejects a non-object payload', () => {
    expect(fields(base('MKTX-003', 'oops' as never))).toContain('payload');
  });

  it('gives events without a dedicated schema envelope validation only', () => {
    expect(
      errorsFor(base('SIPX-004', { anything: 'goes' }, { priority: 5 })),
    ).toEqual([]);
  });
});

describe('RISK-001 / RISK-002 (margin)', () => {
  it('reproduces the spec Appendix A 422: non-positive shortfall + past deadline', () => {
    const errs = errorsFor(
      base(
        'RISK-001',
        margin({ shortfall_amount: -1, deadline: '2020-01-01T00:00:00.000Z' }),
      ),
    );
    expect(errs).toEqual(
      expect.arrayContaining([
        {
          field: 'payload.shortfall_amount',
          error: 'must be a positive number',
        },
        { field: 'payload.deadline', error: 'must be a future timestamp' },
      ]),
    );
  });

  it('requires every margin field', () => {
    const f = fields(base('RISK-002', {}));
    expect(f).toEqual(
      expect.arrayContaining([
        'payload.shortfall_amount',
        'payload.current_margin',
        'payload.required_margin',
        'payload.deadline',
        'payload.auto_square_off_time',
      ]),
    );
  });

  it('allows zero current margin but not a negative one', () => {
    expect(errorsFor(base('RISK-001', margin({ current_margin: 0 })))).toEqual(
      [],
    );
    expect(fields(base('RISK-001', margin({ current_margin: -1 })))).toContain(
      'payload.current_margin',
    );
  });

  it('rejects non-numeric amounts with a type message', () => {
    const errs = errorsFor(
      base('RISK-001', margin({ shortfall_amount: '125000' })),
    );
    expect(errs[0]).toMatchObject({
      field: 'payload.shortfall_amount',
      error: 'must be a number',
    });
  });

  it('applies to RISK-002 as well', () => {
    expect(
      fields(
        base('RISK-002', margin({ deadline: '2020-01-01T00:00:00.000Z' })),
      ),
    ).toContain('payload.deadline');
  });
});

describe('RISK-003 (position squared off)', () => {
  it('does not demand a deadline — the event has already happened', () => {
    expect(
      errorsFor(
        base('RISK-003', { positions_closed: [{ symbol: 'INFY', qty: 10 }] }),
      ),
    ).toEqual([]);
  });
  it('requires at least one closed position', () => {
    expect(fields(base('RISK-003', { positions_closed: [] }))).toContain(
      'payload.positions_closed',
    );
  });
});

describe('TXNX order events', () => {
  const order = {
    stock_name: 'Reliance',
    symbol: 'RELIANCE',
    qty: 10,
    price: 2900,
    total: 29000,
    order_id: 'O-1',
  };

  it('accepts a valid buy and sell', () => {
    expect(errorsFor(base('TXNX-001', order, { priority: 2 }))).toEqual([]);
    expect(errorsFor(base('TXNX-002', order, { priority: 2 }))).toEqual([]);
  });
  it('rejects zero quantity / price', () => {
    expect(
      fields(base('TXNX-001', { ...order, qty: 0, price: 0 }, { priority: 2 })),
    ).toEqual(expect.arrayContaining(['payload.qty', 'payload.price']));
  });
  it('requires an order id', () => {
    const { order_id: _omit, ...rest } = order;
    expect(fields(base('TXNX-002', rest, { priority: 2 }))).toContain(
      'payload.order_id',
    );
  });
  it('TXNX-003 needs an order id and a reason', () => {
    expect(
      errorsFor(
        base(
          'TXNX-003',
          { order_id: 'O-1', reason: 'RMS_REJECT' },
          { priority: 2 },
        ),
      ),
    ).toEqual([]);
    expect(fields(base('TXNX-003', {}, { priority: 2 }))).toEqual(
      expect.arrayContaining(['payload.order_id', 'payload.reason']),
    );
  });
  it('TXNX-004 needs a company and a positive amount', () => {
    expect(
      errorsFor(
        base(
          'TXNX-004',
          { company: 'MTN Nigeria', amount: 1200 },
          { priority: 3 },
        ),
      ),
    ).toEqual([]);
    expect(
      fields(base('TXNX-004', { company: '', amount: -1 }, { priority: 3 })),
    ).toEqual(expect.arrayContaining(['payload.company', 'payload.amount']));
  });
});

describe('TXNX-005 (funds deposited) — also what the payment webhooks emit', () => {
  it('accepts the payload the payments module builds', () => {
    expect(
      errorsFor(
        base(
          'TXNX-005',
          {
            amount: 5000,
            source: 'Paystack',
            currency: 'NGN',
            reference: 'r-1',
          },
          { priority: 2 },
        ),
      ),
    ).toEqual([]);
  });
  it('rejects a missing source and a zero amount', () => {
    expect(fields(base('TXNX-005', { amount: 0 }, { priority: 2 }))).toEqual(
      expect.arrayContaining(['payload.amount', 'payload.source']),
    );
  });
});

describe('MKTX price alerts', () => {
  const alert = {
    symbol: 'RELIANCE',
    target_price: 2900,
    current_price: 2905,
    direction: 'ABOVE',
  };

  it('accepts ABOVE/BELOW in either case', () => {
    expect(errorsFor(base('MKTX-001', alert, { priority: 2 }))).toEqual([]);
    expect(
      errorsFor(
        base('MKTX-001', { ...alert, direction: 'below' }, { priority: 2 }),
      ),
    ).toEqual([]);
  });
  it('rejects an unknown direction', () => {
    expect(
      errorsFor(
        base('MKTX-001', { ...alert, direction: 'sideways' }, { priority: 2 }),
      ),
    ).toEqual([
      { field: 'payload.direction', error: 'must be ABOVE or BELOW' },
    ]);
  });
  it('rejects a negative target price', () => {
    expect(fields(base('MKTX-002', { ...alert, target_price: -1 }))).toContain(
      'payload.target_price',
    );
  });
});

describe('validateEventPayload (boolean form)', () => {
  it('returns valid:true for a good event', () => {
    expect(
      validateEventPayload('RISK-001', base('RISK-001', margin())),
    ).toEqual({ valid: true });
  });
  it('returns readable errors for a bad one', () => {
    const r = validateEventPayload(
      'RISK-001',
      base('RISK-001', margin({ shortfall_amount: -1 })),
    );
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]).toBe(
      'payload.shortfall_amount: must be a positive number',
    );
  });
  it('has dedicated schemas for the events that carry money', () => {
    for (const t of [
      'RISK-001',
      'RISK-002',
      'RISK-003',
      'TXNX-001',
      'TXNX-002',
      'TXNX-005',
      'MKTX-001',
    ]) {
      expect(EVENT_VALIDATORS[t]).toBeDefined();
    }
  });
});
