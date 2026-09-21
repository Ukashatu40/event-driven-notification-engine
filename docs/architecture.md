![alt text](image.png)
BE-6B-NotificationEngine-YourName/
│
├── .github/
│   └── workflows/
│       ├── ci.yml                  # lint → test → build → coverage
│       └── security.yml            # npm audit + snyk on PR
│
├── docs/
│   ├── architecture.md             # C4 diagrams (Mermaid)
│   ├── api-specification.yaml      # OpenAPI 3.0 full spec
│   ├── event-taxonomy.yaml         # All 25+ event types
│   ├── database-schema.md          # ER diagram + table explanations
│   ├── deliberate-error-log.md     # BONUS POINTS — document the 5 errors
│   ├── performance-benchmarks.md   # k6 P50/P95/P99 results
│   └── sequence-diagrams/
│       ├── margin-call-flow.md
│       ├── frequency-cap-flow.md
│       └── provider-failover.md
│
├── src/
│   ├── main.ts                     # NestifyFactory with FastifyAdapter
│   ├── app.module.ts
│   │
│   ├── config/
│   │   ├── database.config.ts
│   │   ├── kafka.config.ts
│   │   ├── redis.config.ts
│   │   ├── rabbitmq.config.ts
│   │   └── env.validation.ts       # Joi/Zod schema for all env vars
│   │
│   ├── events/                     # Domain: raw event ingestion
│   │   ├── events.module.ts
│   │   ├── events.controller.ts    # POST /api/v1/events
│   │   ├── events.service.ts
│   │   ├── models/
│   │   │   ├── base-event.model.ts
│   │   │   ├── risk-event.model.ts
│   │   │   ├── transaction-event.model.ts
│   │   │   ├── sip-event.model.ts
│   │   │   ├── market-event.model.ts
│   │   │   └── regulatory-event.model.ts
│   │   ├── validators/
│   │   │   └── event-payload.validator.ts  # Zod schemas per event type
│   │   └── taxonomy.yaml
│   │
│   ├── notifications/              # Domain: core notification lifecycle
│   │   ├── notifications.module.ts
│   │   ├── notifications.controller.ts   # GET /api/v1/notifications/:id
│   │   ├── notifications.service.ts
│   │   ├── engine/
│   │   │   ├── notification.engine.ts    # orchestrates the pipeline
│   │   │   └── deduplication.service.ts # Redis fingerprint check
│   │   ├── routing/
│   │   │   ├── routing.engine.ts        # weighted scoring algorithm
│   │   │   ├── regulatory-override.ts   # SEBI/TRAI hard rules
│   │   │   └── channel-scorer.ts        # per-channel score computation
│   │   └── state-machine/
│   │       ├── notification.states.ts   # enum + transitions
│   │       └── state.service.ts         # persists transitions to DB
│   │
│   ├── delivery/                   # Domain: actual sending
│   │   ├── delivery.module.ts
│   │   ├── providers/
│   │   │   ├── delivery-provider.interface.ts
│   │   │   ├── sms/
│   │   │   │   ├── msg91.provider.ts
│   │   │   │   └── twilio.provider.ts
│   │   │   ├── email/
│   │   │   │   └── nodemailer.provider.ts
│   │   │   ├── push/
│   │   │   │   └── fcm.provider.ts
│   │   │   ├── whatsapp/
│   │   │   │   └── whatsapp-cloud.provider.ts
│   │   │   └── inapp/
│   │   │       └── websocket.provider.ts
│   │   ├── circuit-breaker/
│   │   │   ├── circuit-breaker.service.ts
│   │   │   └── circuit-breaker.state.ts  # CLOSED/OPEN/HALF_OPEN
│   │   └── retry/
│   │       ├── retry.worker.ts           # Redis sorted set scheduler
│   │       └── retry-policy.config.ts    # per-priority configs
│   │
│   ├── templates/                  # Domain: rendering
│   │   ├── templates.module.ts
│   │   ├── engine/
│   │   │   ├── template.engine.ts        # Handlebars + helpers
│   │   │   ├── personalisation.service.ts
│   │   │   └── sms-truncation.service.ts
│   │   ├── definitions/            # template JSON configs per event
│   │   │   ├── RISK-001.template.json
│   │   │   ├── TXNX-001.template.json
│   │   │   └── ... (25+ files)
│   │   └── locales/
│   │       ├── en.json
│   │       ├── hi.json
│   │       ├── mr.json
│   │       ├── ta.json
│   │       └── te.json
│   │
│   ├── preferences/                # Domain: user settings
│   │   ├── preferences.module.ts
│   │   ├── preferences.controller.ts   # GET/PUT /users/:id/preferences
│   │   ├── preferences.service.ts
│   │   ├── preference-resolver.service.ts   # 4-layer hierarchy
│   │   └── preference-cache.service.ts      # Redis cache + invalidation
│   │
│   ├── compliance/                 # Domain: regulatory
│   │   ├── compliance.module.ts
│   │   ├── dnd/
│   │   │   ├── dnd.service.ts            # lookup + local cache
│   │   │   ├── dnd-classifier.service.ts # TRANSACTIONAL vs PROMOTIONAL
│   │   │   └── consent.service.ts        # immutable audit log
│   │   ├── frequency-cap/
│   │   │   ├── frequency-cap.service.ts  # Redis atomic INCR
│   │   │   └── cap-config.ts             # multi-dimensional config
│   │   └── quiet-hours/
│   │       ├── quiet-hours.service.ts
│   │       └── digest-aggregator.service.ts
│   │
│   ├── analytics/                  # Domain: metrics + reporting
│   │   ├── analytics.module.ts
│   │   ├── analytics.controller.ts # GET /analytics/delivery-rates etc
│   │   ├── analytics.service.ts
│   │   ├── metrics.service.ts      # Prometheus counter/histogram/gauge
│   │   └── realtime-counters.service.ts  # Redis sliding window
│   │
│   ├── api/                        # Cross-cutting HTTP layer
│   │   ├── middleware/
│   │   │   ├── correlation-id.middleware.ts
│   │   │   ├── request-logger.middleware.ts
│   │   │   └── rate-limit.guard.ts
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts
│   │   │   └── rbac.guard.ts
│   │   ├── interceptors/
│   │   │   └── response-transform.interceptor.ts
│   │   └── validators/
│   │       └── global-validation.pipe.ts
│   │
│   ├── infrastructure/             # Technical adapters
│   │   ├── kafka/
│   │   │   ├── kafka.module.ts
│   │   │   ├── kafka-producer.service.ts
│   │   │   └── kafka-consumer.service.ts
│   │   ├── rabbitmq/
│   │   │   ├── rabbitmq.module.ts
│   │   │   └── rabbitmq.service.ts
│   │   ├── redis/
│   │   │   ├── redis.module.ts
│   │   │   └── redis.service.ts
│   │   └── database/
│   │       ├── migrations/         # Prisma migrations
│   │       ├── seeds/
│   │       └── prisma.service.ts
│   │
│   ├── shared/                     # Zero-dependency utilities
│   │   ├── constants/
│   │   │   ├── event-types.ts
│   │   │   ├── channels.ts
│   │   │   └── priorities.ts
│   │   ├── decorators/
│   │   │   └── correlation-id.decorator.ts
│   │   ├── dto/
│   │   │   ├── ingest-event.dto.ts
│   │   │   └── pagination.dto.ts
│   │   ├── exceptions/
│   │   │   ├── notification.exceptions.ts
│   │   │   └── global-exception.filter.ts
│   │   └── utils/
│   │       ├── pii-masker.util.ts
│   │       ├── currency-formatter.util.ts
│   │       └── timezone.util.ts
│   │
│   └── health/
│       ├── health.module.ts
│       └── health.controller.ts    # /health, /metrics, /ready, /live
│
├── templates/                      # Handlebars .hbs files
│   ├── email/
│   │   ├── RISK-001.hbs
│   │   └── TXNX-001.hbs
│   └── whatsapp/
│
├── tests/
│   ├── unit/                       # Jest unit tests mirroring src/
│   ├── integration/                # Tests using testcontainers
│   ├── e2e/                        # Full pipeline Supertest flows
│   └── load/
│       ├── market-crash.k6.ts      # 450K alerts scenario
│       ├── margin-calls.k6.ts      # 28K margin calls
│       ├── provider-outage.k6.ts
│       └── multi-language.k6.ts    # 4.2M notifications
│
├── scripts/
│   ├── generate-datasets.ts        # Creates the 4 CSV datasets
│   └── (seeds moved to src/database/seeds/)
│
├── docker-compose.yml
├── docker-compose.test.yml
├── Dockerfile                      # Multi-stage: builder → production
├── .env.example
├── .zetheta-project.json
├── tsconfig.json                   # strict: true, noImplicitAny: true
├── jest.config.ts
├── package.json
├── README.md
├── ARCHITECTURE.md
├── CHANGELOG.md
└── DEPLOYMENT.md