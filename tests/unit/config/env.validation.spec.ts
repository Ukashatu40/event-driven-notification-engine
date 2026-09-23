// tests/unit/config/env.validation.spec.ts
import { envValidationSchema } from '../../../src/config/env.validation';

const good = () => ({
  NODE_ENV: 'production',
  JWT_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  PII_ENCRYPTION_KEY: 'c'.repeat(64),
  PII_HASH_KEY: 'd'.repeat(40),
  DB_HOST: 'db',
  DB_NAME: 'n',
  DB_USER: 'u',
  DB_PASSWORD: 'p',
  DATABASE_URL: 'postgresql://u:p@db:5432/n',
  REDIS_HOST: 'r',
  REDIS_PASSWORD: 'p',
  KAFKA_BROKERS: 'k:9092',
  KAFKA_CLIENT_ID: 'c',
  KAFKA_GROUP_ID_STANDARD: 's',
  KAFKA_GROUP_ID_CRITICAL: 'c',
  RABBITMQ_URL: 'amqp://u:p@rb:5672',
  SMTP_HOST: 'smtp',
  SMTP_FROM: 'a@b.co',
  WEBHOOK_SIGNATURE_SECRET: 'w'.repeat(20),
});
const validate = (over: Record<string, unknown> = {}) =>
  envValidationSchema.validate({ ...good(), ...over }, { allowUnknown: true });

describe('environment validation — the app refuses to boot on an unsafe configuration', () => {
  it('accepts a complete, sane environment', () => {
    expect(validate().error).toBeUndefined();
  });

  it('rejects one secret used for both access and refresh tokens', () => {
    const r = validate({ JWT_REFRESH_SECRET: 'a'.repeat(40) });
    expect(r.error?.message).toMatch(
      /JWT_REFRESH_SECRET must differ from JWT_SECRET/,
    );
  });

  it.each(['JWT_SECRET', 'JWT_REFRESH_SECRET', 'PII_HASH_KEY'])(
    'rejects a short %s',
    (k) => {
      expect(validate({ [k]: 'short' }).error).toBeDefined();
    },
  );

  it('rejects a PII encryption key that is not 64 hex characters', () => {
    expect(
      validate({ PII_ENCRYPTION_KEY: 'z'.repeat(64) }).error,
    ).toBeDefined();
    expect(validate({ PII_ENCRYPTION_KEY: 'abcd' }).error).toBeDefined();
  });

  it('requires the PII keys at all (no silent fallback)', () => {
    const { PII_ENCRYPTION_KEY: _a, ...rest } = good();
    expect(
      envValidationSchema.validate(rest, { allowUnknown: true }).error,
    ).toBeDefined();
  });

  it('CONSENT_ENFORCEMENT defaults to enforce and only accepts enforce|audit|off', () => {
    expect(validate().value.CONSENT_ENFORCEMENT).toBe('enforce');
    expect(validate({ CONSENT_ENFORCEMENT: 'audit' }).error).toBeUndefined();
    expect(validate({ CONSENT_ENFORCEMENT: 'sometimes' }).error).toBeDefined();
  });

  it('KAFKA_SSL is an explicit true|false (default false), never inferred from NODE_ENV', () => {
    expect(validate().value.KAFKA_SSL).toBe('false');
    expect(validate({ KAFKA_SSL: 'true' }).error).toBeUndefined();
    expect(validate({ KAFKA_SSL: 'yes' }).error).toBeDefined();
  });
});

describe('Kafka TLS configuration', () => {
  const load = (env: Record<string, string>) => {
    jest.resetModules();
    const saved = { ...process.env };
    Object.assign(process.env, env);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = (
      require('../../../src/config/kafka.config') as {
        kafkaConfig: () => { ssl: boolean };
      }
    ).kafkaConfig();
    process.env = saved;
    return cfg;
  };

  it('a production-mode process is NOT forced onto TLS (the docker-compose broker is plaintext)', () => {
    expect(load({ NODE_ENV: 'production', KAFKA_SSL: 'false' }).ssl).toBe(
      false,
    );
    expect(load({ NODE_ENV: 'production' }).ssl).toBe(false);
  });

  it('KAFKA_SSL=true turns TLS on in any environment', () => {
    expect(load({ NODE_ENV: 'development', KAFKA_SSL: 'true' }).ssl).toBe(true);
  });
});
