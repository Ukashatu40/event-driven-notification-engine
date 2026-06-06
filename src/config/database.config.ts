// src/config/database.config.ts
import { registerAs } from '@nestjs/config';

export const databaseConfig = registerAs('database', () => ({
  url: process.env.DATABASE_URL ?? '',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  name: process.env.DB_NAME ?? 'notification_engine',
  user: process.env.DB_USER ?? 'notification_user',
  password: process.env.DB_PASSWORD ?? '',
  // Connection pool — tuned for 2M+ daily notifications
  pool: {
    min: 2,
    max: 20,
    acquireTimeoutMs: 30_000,
    idleTimeoutMs: 600_000,
  },
  ssl: process.env.NODE_ENV === 'production',
}));
