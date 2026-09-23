// src/config/env.validation.ts
// import Joi from 'joi';
import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  // App
  NODE_ENV: Joi.string()
    .valid('development', 'staging', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  APP_NAME: Joi.string().default('WealthBridge'),

  // JWT
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRY: Joi.string().default('1h'),
  JWT_REFRESH_SECRET: Joi.string()
    .min(32)
    .required()
    // With one secret for both, a 7-day refresh token verifies as an access
    // token and the 1-hour access TTL means nothing.
    .invalid(Joi.ref('JWT_SECRET'))
    .messages({
      'any.invalid': 'JWT_REFRESH_SECRET must differ from JWT_SECRET',
    }),
  JWT_REFRESH_EXPIRY: Joi.string().default('7d'),

  // End-user OTP login (ADR-008)
  OTP_CODE_TTL_SECONDS: Joi.number().integer().min(60).default(300),
  OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: Joi.number().integer().min(10).default(60),

  // API credentials, one per role (empty = that role cannot log in)
  SERVICE_API_KEY: Joi.string().optional().allow(''),
  OPERATOR_API_KEY: Joi.string().optional().allow(''),
  ADMIN_API_KEY: Joi.string().optional().allow(''),

  KAFKA_SSL: Joi.string().valid('true', 'false').default('false'),
  // PEM CA certificate for a provider (e.g. Aiven) whose Kafka broker uses
  // its own CA rather than a publicly trusted one. See kafka.config.ts.
  KAFKA_SSL_CA: Joi.string().allow('').default(''),
  CONSENT_ENFORCEMENT: Joi.string()
    .valid('enforce', 'audit', 'off')
    .default('enforce'),

  // PII protection (spec A10.2). Generate each with: openssl rand -hex 32
  // Keep them different from each other and from the JWT secrets.
  PII_ENCRYPTION_KEY: Joi.string()
    .hex()
    .length(64)
    .required()
    .description('AES-256-GCM key for phone/email columns (32 bytes, hex)'),
  PII_HASH_KEY: Joi.string()
    .min(32)
    .required()
    .description('HMAC key for phone/email blind indexes'),

  // Nigeria: SMS + payment webhooks (all optional; a webhook whose secret is
  // missing rejects every request — it fails closed)
  TERMII_API_KEY: Joi.string().optional().allow(''),
  TERMII_SENDER_ID: Joi.string().max(11).optional().allow(''),
  TERMII_BASE_URL: Joi.string().uri().optional().allow(''),
  PAYSTACK_SECRET_KEY: Joi.string().optional().allow(''),
  FLUTTERWAVE_SECRET_HASH: Joi.string().optional().allow(''),
  OPAY_SECRET_KEY: Joi.string().optional().allow(''),
  INTERSWITCH_SECRET_KEY: Joi.string().optional().allow(''),

  // PostgreSQL
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_NAME: Joi.string().required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DATABASE_URL: Joi.string().uri().required(),

  // Redis
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().required(),
  REDIS_DB: Joi.number().default(0),
  REDIS_TLS: Joi.string().valid('true', 'false').default('false'),

  // Kafka
  KAFKA_BROKERS: Joi.string().required(),
  KAFKA_CLIENT_ID: Joi.string().required(),
  KAFKA_GROUP_ID_STANDARD: Joi.string().required(),
  KAFKA_GROUP_ID_CRITICAL: Joi.string().required(),

  // RabbitMQ
  RABBITMQ_URL: Joi.string().required(),
  RABBITMQ_EXCHANGE: Joi.string().default('notifications'),
  RABBITMQ_DLX: Joi.string().default('notifications.dlx'),

  // SMS
  MSG91_API_KEY: Joi.string().allow('').default(''),
  MSG91_SENDER_ID: Joi.string().default('WLTHBR'),
  MSG91_TEMPLATE_ID: Joi.string().allow('').default(''),
  TWILIO_ACCOUNT_SID: Joi.string().allow('').default(''),
  TWILIO_AUTH_TOKEN: Joi.string().allow('').default(''),
  TWILIO_FROM_NUMBER: Joi.string().allow('').default(''),

  // Email
  SMTP_HOST: Joi.string().required(),
  SMTP_PORT: Joi.number().default(587),
  SMTP_USER: Joi.string().allow('').default(''),
  SMTP_PASS: Joi.string().allow('').default(''),
  // tlds: { allow: false } — Joi's default .email() checks the domain
  // against a real IANA TLD list, which rejects reserved test domains like
  // noreply@example.test (RFC 2606) that CI/local configs legitimately use.
  SMTP_FROM: Joi.string()
    .email({ tlds: { allow: false } })
    .required(),

  // FCM
  FCM_PROJECT_ID: Joi.string().allow('').default(''),
  FCM_PRIVATE_KEY: Joi.string().allow('').default(''),
  FCM_CLIENT_EMAIL: Joi.string().allow('').default(''),

  // WhatsApp
  WHATSAPP_PHONE_ID: Joi.string().allow('').default(''),
  WHATSAPP_ACCESS_TOKEN: Joi.string().allow('').default(''),

  // Security
  WEBHOOK_SIGNATURE_SECRET: Joi.string().min(16).required(),
  CORS_ORIGINS: Joi.string().default('http://localhost:3000'),

  // Feature flags
  ENABLE_AB_TESTING: Joi.boolean().default(true),
  ENABLE_SEND_TIME_OPTIMIZATION: Joi.boolean().default(true),
  ENABLE_WEBSOCKET_DASHBOARD: Joi.boolean().default(true),
}).options({ allowUnknown: true }); // allows OS env vars to pass through
