// Central registry of all Redis key patterns.
// Every key in the system is defined here — never hardcode strings elsewhere.

export const REDIS_KEYS = {
  // Frequency capping
  capGlobalDaily: (userId: string) => `notif:cap:${userId}:global:daily`,
  capChannelDaily: (userId: string, channel: string) =>
    `notif:cap:${userId}:channel:${channel}:daily`,
  capCategoryHourly: (userId: string, category: string) =>
    `notif:cap:${userId}:category:${category}:hourly`,
  capTypeCooldown: (userId: string, eventType: string) =>
    `notif:cap:${userId}:type:${eventType}:cooldown`,

  // Deduplication
  dedup: (fingerprint: string) => `notif:dedup:${fingerprint}`,

  // Idempotency
  idempotency: (key: string) => `notif:idempotency:${key}`,

  // Retry queue (sorted set per priority)
  retryQueue: (priority: number) => `notif:retry:queue:${priority}`,

  // User preference cache
  userPrefs: (userId: string) => `user:${userId}:prefs`,

  // User engagement feature store
  userEngagement: (userId: string) => `user:${userId}:engagement`,

  // DND cache
  // Keyed by user id, not phone number: no PII in Redis keys.
  dndStatus: (userId: string) => `dnd:${userId}`,

  // Circuit breaker
  circuitBreakerState: (provider: string) => `cb:${provider}:state`,
  circuitBreakerFailures: (provider: string) => `cb:${provider}:failures`,
  circuitBreakerLastAttempt: (provider: string) =>
    `cb:${provider}:last_attempt`,

  // Quiet hours queue (sorted set, score = unix delivery timestamp)
  quietQueue: (userId: string) => `notif:quiet:${userId}`,

  // Deferred releases (quiet hours / send-time optimisation):
  // sorted set, score = unix release time, member = JSON {id, channels}
  scheduledRelease: 'notif:scheduled',

  // Digest buckets: sorted set of notification ids per (user, source), and a
  // global "due" set whose member is "<userId>|<source>", scored by flush time.
  digestBucket: (userId: string, source: string) =>
    `notif:digest:${userId}:${source}`,
  digestDue: 'notif:digest:due',

  // Rate limiting (sliding window)
  rateLimit: (identifier: string, endpoint: string, windowStart: number) =>
    `rl:${identifier}:${endpoint}:${windowStart}`,

  // Analytics real-time counters
  analyticsCounter: (metric: string, window: string) =>
    `analytics:${metric}:${window}`,

  // Refresh-token rotation: jti → token family; revoked families
  authRefresh: (jti: string) => `auth:refresh:${jti}`,
  authRevokedFamily: (family: string) => `auth:revoked:${family}`,

  // Send-time optimisation — per-user hourly open rates
  sendTimeScores: (userId: string) => `sto:${userId}:hourly_scores`,
} as const;

// TTL constants in seconds
export const TTL = {
  CAP_DAILY: 86_400,
  CAP_HOURLY: 3_600,
  CAP_COOLDOWN: 900, // 15 minutes
  DEDUP: 300, // 5 minutes
  IDEMPOTENCY: 86_400,
  USER_PREFS: 3_600,
  DND: 86_400,
  CIRCUIT_BREAKER_FAILURE_WINDOW: 60,
  ANALYTICS_REALTIME: 1_800, // 30 minutes
} as const;
