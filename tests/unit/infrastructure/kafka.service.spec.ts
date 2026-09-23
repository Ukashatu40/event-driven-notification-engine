// tests/unit/infrastructure/kafka.service.spec.ts
//
// Only the SSL/CA construction branch — the rest of KafkaService is exercised
// by the real broker in integration/e2e tests. This one bug (KAFKA_SSL=true
// alone rejecting Aiven's self-issued broker cert with "self-signed
// certificate in certificate chain") only shows up against a real managed
// broker, so it's worth locking the fix down here rather than re-discovering
// it on the next provider switch.
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

import { KafkaService } from '../../../src/infrastructure/kafka/kafka.service';

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

  it('ssl:true with no CA behaves exactly as before (plain ssl:true)', () => {
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
});
