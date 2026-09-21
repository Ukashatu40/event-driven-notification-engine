// src/database/models/index.ts
//
// Domain model types. The models are defined once, in prisma/schema.prisma, and
// generated into @prisma/client; this barrel is the single import point for them
// so application code never reaches into the generated package directly.
export type {
  User,
  Notification,
  NotificationStateLog,
  DeliveryAttempt,
  DeadLetterQueue,
  UserPreference,
  ConsentRecord,
  ProviderHealth,
  Language,
  Market,
  NotificationStatus,
  MessageClassification,
  DigestMode,
} from '@prisma/client';
