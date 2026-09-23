// tests/unit/api/contract.spec.ts
import { of, lastValueFrom } from 'rxjs';
import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { snakeKeys, camelKeys } from '../../../src/shared/utils/case.util';
import { ResponseTransformInterceptor } from '../../../src/api/interceptors/response-transform.interceptor';
import { RequestCaseInterceptor } from '../../../src/api/interceptors/request-case.interceptor';
import { GlobalExceptionFilter } from '../../../src/shared/exceptions/global-exception.filter';
import {
  createValidationPipe,
  flattenValidationErrors,
  ValidationFailedException,
} from '../../../src/shared/pipes/validation.pipe';
import { IngestEventDto } from '../../../src/notifications/dto/ingest-event.dto';
import { UpdatePreferenceDto } from '../../../src/preferences/dto/update-preference.dto';

describe('case conversion', () => {
  it('snake_cases response keys recursively, including arrays', () => {
    expect(
      snakeKeys({
        notificationId: 'n',
        stateHistory: [{ fromStatus: 'A', toStatus: 'B' }],
      }),
    ).toEqual({
      notification_id: 'n',
      state_history: [{ from_status: 'A', to_status: 'B' }],
    });
  });

  it('leaves non-identifier keys alone (CRITICAL, TXNX-001, in_app)', () => {
    expect(
      snakeKeys({
        byPriority: { CRITICAL: { p99LatencyMs: 1 } },
        'TXNX-001': 1,
        in_app: true,
      }),
    ).toEqual({
      by_priority: { CRITICAL: { p99_latency_ms: 1 } },
      'TXNX-001': 1,
      in_app: true,
    });
  });

  it('does not rewrite free-form JSON: payload, metadata, rendered content, channels', () => {
    const out = snakeKeys({
      renderedContent: { deepKey: { camelCase: 1 } },
      metadata: { someKey: 1 },
      channels: { in_app: true },
      payload: { userName: 'x' },
    }) as Record<string, unknown>;
    expect(out['rendered_content']).toEqual({ deepKey: { camelCase: 1 } });
    expect(out['metadata']).toEqual({ someKey: 1 });
    expect(out['payload']).toEqual({ userName: 'x' });
  });

  it('converts the rows inside a paginated {data, meta} envelope', () => {
    expect(
      snakeKeys({
        data: [{ failureClass: 'TRANSIENT', lastError: 'X' }],
        meta: { totalPages: 1 },
      }),
    ).toEqual({
      data: [{ failure_class: 'TRANSIENT', last_error: 'X' }],
      meta: { total_pages: 1 },
    });
  });

  it('passes primitives, null, Dates and strings straight through', () => {
    const d = new Date();
    expect(snakeKeys('text')).toBe('text');
    expect(snakeKeys(null)).toBeNull();
    expect(snakeKeys(7)).toBe(7);
    expect(
      (snakeKeys({ createdAt: d }) as { created_at: Date }).created_at,
    ).toBe(d);
  });

  it('camelCases request keys and is idempotent', () => {
    const once = camelKeys({
      event_type: 'RISK-001',
      user_id: 'u',
      idempotency_key: 'k',
    });
    expect(once).toEqual({
      eventType: 'RISK-001',
      userId: 'u',
      idempotencyKey: 'k',
    });
    expect(camelKeys(once)).toEqual(once);
  });

  it('does not convert channel ids (in_app) or the producer payload', () => {
    expect(
      camelKeys({
        digest_mode: 'daily',
        channels: { in_app: true },
        payload: { shortfall_amount: 1 },
      }),
    ).toEqual({
      digestMode: 'daily',
      channels: { in_app: true },
      payload: { shortfall_amount: 1 },
    });
  });
});

describe('ResponseTransformInterceptor', () => {
  it('returns the bare snake_case body — no {success, data} envelope', async () => {
    const out = await lastValueFrom(
      new ResponseTransformInterceptor().intercept({} as never, {
        handle: () => of({ notificationId: 'n-1' }),
      }),
    );
    expect(out).toEqual({ notification_id: 'n-1' });
  });
});

describe('RequestCaseInterceptor', () => {
  const run = (url: string, body: unknown) => {
    const request = { url, body };
    const ctx = { switchToHttp: () => ({ getRequest: () => request }) };
    new RequestCaseInterceptor().intercept(ctx as never, {
      handle: () => of(null),
    });
    return request.body;
  };

  it('converts snake_case bodies on the versioned API', () => {
    expect(run('/api/v1/events', { event_type: 'X', user_id: 'u' })).toEqual({
      eventType: 'X',
      userId: 'u',
    });
  });

  it('NEVER touches provider webhook bodies (signed bytes, provider key names)', () => {
    const body = { data: { tx_ref: 'r', customer: { email: 'e' } } };
    expect(run('/api/webhooks/payments/flutterwave', body)).toBe(body);
    expect(body.data.tx_ref).toBe('r');
  });

  it('ignores requests without a body', () => {
    expect(run('/api/v1/events', undefined)).toBeUndefined();
  });
});

describe('spec Appendix A request bodies pass validation after conversion', () => {
  const pipe = createValidationPipe();
  const meta = (type: unknown) => ({
    type: 'body' as const,
    metatype: type as never,
  });

  it('POST /events body (snake_case) is accepted', async () => {
    const body = camelKeys({
      event_type: 'RISK-001',
      event_id: 'EVT-2025-03-19-MC-847291',
      source_system: 'margin_engine',
      timestamp: '2025-03-19T10:15:23.456Z',
      priority: 1,
      user_id: '11111111-1111-4111-8111-111111111111',
      payload: { shortfall_amount: 125000 },
      idempotency_key: 'margin-call-usr_a1b2c3d4-2025-03-19T10:15',
    });
    const dto = (await pipe.transform(
      body,
      meta(IngestEventDto),
    )) as IngestEventDto;
    expect(dto.eventType).toBe('RISK-001');
    expect(dto.idempotencyKey).toMatch(/^margin-call/);
  });

  it('PUT /preferences body accepts digest_mode "daily" (lowercase) and in_app', async () => {
    const body = camelKeys({
      category: 'MKTX',
      channels: {
        sms: false,
        email: false,
        push: true,
        whatsapp: false,
        in_app: true,
      },
      digest_mode: 'daily',
    });
    const dto = (await pipe.transform(
      body,
      meta(UpdatePreferenceDto),
    )) as UpdatePreferenceDto;
    expect(dto.digestMode).toBe('DAILY');
  });

  it('an unknown field is rejected with 422 and a field-level detail', async () => {
    await expect(
      pipe.transform(
        { category: 'MKTX', channels: {}, surprise: 1 },
        meta(UpdatePreferenceDto),
      ),
    ).rejects.toMatchObject({
      status: 422,
      response: {
        error: 'VALIDATION_FAILED',
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'surprise' }),
        ]),
      },
    });
  });

  it('flattens nested errors to dotted field paths', () => {
    const out = flattenValidationErrors([
      {
        property: 'channels',
        children: [
          {
            property: 'sms',
            constraints: { isBoolean: 'sms must be a boolean' },
            children: [],
          },
        ],
      },
    ] as never);
    expect(out).toEqual([
      { field: 'channels.sms', error: 'sms must be a boolean' },
    ]);
  });
});

describe('GlobalExceptionFilter — spec Appendix A error shape', () => {
  const send = jest.fn();
  const reply = { status: jest.fn().mockReturnValue({ send }) };
  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({
        url: '/api/v1/events',
        method: 'POST',
        headers: {},
      }),
    }),
  };
  const filter = new GlobalExceptionFilter();
  const body = () => send.mock.calls[0][0];

  beforeEach(
    () =>
      jest.clearAllMocks().valueOf() ?? reply.status.mockReturnValue({ send }),
  );

  it('422 VALIDATION_FAILED carries details and request_id', () => {
    filter.catch(
      new ValidationFailedException(
        [
          {
            field: 'payload.shortfall_amount',
            error: 'must be a positive number',
          },
        ],
        'Event payload validation failed',
      ),
      host as never,
    );
    expect(reply.status).toHaveBeenCalledWith(422);
    expect(body()).toMatchObject({
      error: 'VALIDATION_FAILED',
      message: 'Event payload validation failed',
      details: [
        {
          field: 'payload.shortfall_amount',
          error: 'must be a positive number',
        },
      ],
      status_code: 422,
    });
    expect(body().request_id).toEqual(expect.any(String));
  });

  it('turns Nest phrases into error codes (Not Found → NOT_FOUND)', () => {
    filter.catch(new NotFoundException('User x not found'), host as never);
    expect(body()).toMatchObject({
      error: 'NOT_FOUND',
      message: 'User x not found',
      status_code: 404,
    });
  });

  it('surfaces a built-in message array as details, not as the message', () => {
    filter.catch(
      new BadRequestException(['a must be a string', 'b is required']),
      host as never,
    );
    expect(body().message).toBe('Request validation failed');
    expect(body().details).toEqual(['a must be a string', 'b is required']);
  });

  it('hides internal error text in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    filter.catch(new Error('db password is hunter2'), host as never);
    process.env.NODE_ENV = prev;
    expect(body().message).toBe('An unexpected error occurred');
    expect(JSON.stringify(body())).not.toContain('hunter2');
    expect(reply.status).toHaveBeenCalledWith(500);
  });

  it('a plain UnprocessableEntityException still yields a code', () => {
    filter.catch(new UnprocessableEntityException('nope'), host as never);
    expect(body().error).toBe('UNPROCESSABLE_ENTITY');
  });
});
