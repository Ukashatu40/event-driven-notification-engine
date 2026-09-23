// src/config/app.config.ts
import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  name: process.env.APP_NAME ?? 'WealthBridge',
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV === 'development',
  isTest: process.env.NODE_ENV === 'test',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
  webhookSignatureSecret: process.env.WEBHOOK_SIGNATURE_SECRET ?? '',
  features: {
    abTesting: process.env.ENABLE_AB_TESTING === 'true',
    sendTimeOptimization: process.env.ENABLE_SEND_TIME_OPTIMIZATION === 'true',
    websocketDashboard: process.env.ENABLE_WEBSOCKET_DASHBOARD === 'true',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? '',
    expiry: process.env.JWT_EXPIRY ?? '1h',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY ?? '7d',
  },
  // One credential per role: holding the SERVICE key must never let you mint an
  // ADMIN token. A role whose key is unset cannot log in at all.
  // enforce (default): block sends that lack consent. audit: allow but log +
  // count them — for migrating existing users. off: do not check.
  consentEnforcement: process.env.CONSENT_ENFORCEMENT ?? 'enforce',
  serviceKey: process.env.SERVICE_API_KEY ?? '',
  operatorKey: process.env.OPERATOR_API_KEY ?? '',
  adminKey: process.env.ADMIN_API_KEY ?? '',
  webhooks: {
    msg91Secret: process.env.MSG91_WEBHOOK_SECRET ?? '',
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    fcmSecret: process.env.FCM_WEBHOOK_SECRET ?? '',
    whatsappAppSecret: process.env.WHATSAPP_APP_SECRET ?? '',
  },
}));
