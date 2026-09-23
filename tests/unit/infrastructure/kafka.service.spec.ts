// tests/unit/infrastructure/kafka.service.spec.ts
//
// Only the SSL/CA/client-cert construction branch — the rest of KafkaService
// is exercised by the real broker in integration/e2e tests. Two bugs only
// showed up against a real managed broker, so they're worth locking down
// here rather than re-discovering them on the next provider switch:
//   1. KAFKA_SSL=true alone rejects Aiven's self-issued broker cert with
//      "self-signed certificate in certificate chain" (needs the CA).
//   2. Some Aiven Kafka services additionally require mutual TLS — the
//      broker sends "certificate required" before Kafka's own protocol
//      (SASL included) even starts, independent of correct SASL config.
const kafkaCtor = jest.fn();
jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation((config: unknown) => {
    kafkaCtor(config);
    return {
      producer: () => ({ connect: jest.fn(), disconnect: jest.fn() }),
      admin: () => ({ connect: jest.fn(), disconnect: jest.fn() }),
    };
  }),
}));

import {
  KafkaService,
  normalizePemMaterial,
} from '../../../src/infrastructure/kafka/kafka.service';

function build(config: Record<string, unknown>) {
  const configService = { get: (key: string) => config[key] };
  return new KafkaService(configService as never);
}

describe('KafkaService SSL construction', () => {
  beforeEach(() => kafkaCtor.mockClear());

  it('ssl:false stays plaintext, no matter what sslCa holds', () => {
    build({ 'kafka.ssl': false, 'kafka.sslCa': '-----BEGIN CERTIFICATE-----' });
    expect(kafkaCtor.mock.calls[0][0].ssl).toBeUndefined();
  });

  it('ssl:true with nothing else behaves exactly as before (plain ssl:true)', () => {
    build({ 'kafka.ssl': true, 'kafka.sslCa': '' });
    expect(kafkaCtor.mock.calls[0][0].ssl).toBe(true);
  });

  it('ssl:true with a CA passes it to kafkajs instead of bare ssl:true — the Aiven fix', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    build({ 'kafka.ssl': true, 'kafka.sslCa': ca });
    expect(kafkaCtor.mock.calls[0][0].ssl).toEqual({
      ca: [ca],
      rejectUnauthorized: true,
    });
  });

  it('tolerates a literal backslash-n from a UI that flattened real newlines on paste', () => {
    build({
      'kafka.ssl': true,
      'kafka.sslCa':
        '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----',
    });
    const passed = kafkaCtor.mock.calls[0][0].ssl.ca[0] as string;
    expect(passed).toBe(
      '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
    );
    expect(passed).not.toContain('\\n');
  });

  it('accepts a base64-encoded CA — the robust form for a form field that collapses newlines', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    build({
      'kafka.ssl': true,
      'kafka.sslCa': Buffer.from(pem, 'utf8').toString('base64'),
    });
    expect(kafkaCtor.mock.calls[0][0].ssl.ca[0]).toBe(pem);
  });

  it('a client cert+key is sent alongside the CA — the mutual-TLS fix', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----';
    const cert = '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----';
    const key = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----';
    build({
      'kafka.ssl': true,
      'kafka.sslCa': ca,
      'kafka.sslClientCert': cert,
      'kafka.sslClientKey': key,
    });
    expect(kafkaCtor.mock.calls[0][0].ssl).toEqual({
      ca: [ca],
      cert,
      key,
      rejectUnauthorized: true,
    });
  });

  it('a client cert without a CA still works — mTLS-only, no separate CA configured', () => {
    const cert = '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----';
    const key = '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----';
    build({
      'kafka.ssl': true,
      'kafka.sslClientCert': cert,
      'kafka.sslClientKey': key,
    });
    expect(kafkaCtor.mock.calls[0][0].ssl).toEqual({
      cert,
      key,
      rejectUnauthorized: true,
    });
  });

  it('a cert with no matching key is ignored — half a keypair authenticates nothing', () => {
    build({
      'kafka.ssl': true,
      'kafka.sslClientCert':
        '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----',
    });
    expect(kafkaCtor.mock.calls[0][0].ssl).toBe(true);
  });

  it('drops SASL once a client cert is configured — a plain-SSL listener never expects a SaslHandshake', () => {
    // Confirmed live against a real broker: sending both produces
    // "Request is not valid given the current SASL state" (ILLEGAL_SASL_STATE)
    // — a protocol violation, not a credentials problem.
    build({
      'kafka.ssl': true,
      'kafka.sslClientCert':
        '-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----',
      'kafka.sslClientKey':
        '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
      'kafka.sasl': { mechanism: 'plain', username: 'u', password: 'p' },
    });
    expect(kafkaCtor.mock.calls[0][0].sasl).toBeUndefined();
  });

  it('still sends SASL when there is no client cert — unrelated services keep working', () => {
    build({
      'kafka.ssl': true,
      'kafka.sslCa':
        '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----',
      'kafka.sasl': { mechanism: 'plain', username: 'u', password: 'p' },
    });
    expect(kafkaCtor.mock.calls[0][0].sasl).toEqual({
      mechanism: 'plain',
      username: 'u',
      password: 'p',
    });
  });
});

describe('normalizePemMaterial', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';

  it('passes real PEM through unchanged', () => {
    expect(normalizePemMaterial(pem)).toBe(pem);
  });

  it('un-escapes a literal backslash-n', () => {
    expect(normalizePemMaterial(pem.replace(/\n/g, '\\n'))).toBe(pem);
  });

  it('decodes base64', () => {
    expect(normalizePemMaterial(Buffer.from(pem).toString('base64'))).toBe(pem);
  });

  it('also recognizes a private key, not just a certificate', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    expect(normalizePemMaterial(Buffer.from(key).toString('base64'))).toBe(key);
  });

  it('falls through unchanged when it is neither — never silently drops a broken value', () => {
    const garbage = 'not a certificate at all';
    expect(normalizePemMaterial(garbage)).toBe(garbage);
  });
});
