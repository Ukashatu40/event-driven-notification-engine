const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  PageBreak,
  LevelFormat,
  UnderlineType,
} = require('docx');
const fs = require('fs');

const ACCENT = '1F4E79';
const ACCENT2 = '2E75B6';
const LIGHT_BLUE = 'D6E4F0';
const LIGHT_GRAY = 'F2F2F2';
const WHITE = 'FFFFFF';
const GREEN = '1E7E34';
const RED = 'C00000';

const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const noBorders = {
  top: noBorder,
  bottom: noBorder,
  left: noBorder,
  right: noBorder,
};

const cellMargins = { top: 100, bottom: 100, left: 150, right: 150 };

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [
      new TextRun({ text, bold: true, size: 32, color: ACCENT, font: 'Arial' }),
    ],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 140 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 4, color: ACCENT2, space: 4 },
    },
    children: [
      new TextRun({
        text,
        bold: true,
        size: 26,
        color: ACCENT2,
        font: 'Arial',
      }),
    ],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100 },
    children: [
      new TextRun({ text, bold: true, size: 22, color: ACCENT, font: 'Arial' }),
    ],
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text, size: 20, font: 'Arial', ...opts })],
  });
}

function mono(text) {
  return new Paragraph({
    spacing: { before: 40, after: 40 },
    indent: { left: 360 },
    children: [
      new TextRun({ text, font: 'Courier New', size: 18, color: '444444' }),
    ],
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    numbering: { reference: 'bullets', level },
    spacing: { before: 40, after: 40 },
    children: [new TextRun({ text, size: 20, font: 'Arial' })],
  });
}

function tick(text) {
  return new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    spacing: { before: 40, after: 40 },
    children: [
      new TextRun({ text: '\u2705 ', size: 20 }),
      new TextRun({ text, size: 20, font: 'Arial' }),
    ],
  });
}

function pageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
}

function spacer() {
  return new Paragraph({
    spacing: { before: 100, after: 100 },
    children: [new TextRun('')],
  });
}

function headerRow(cells, widths) {
  return new TableRow({
    tableHeader: true,
    children: cells.map(
      (text, i) =>
        new TableCell({
          borders,
          margins: cellMargins,
          width: { size: widths[i], type: WidthType.DXA },
          shading: { fill: ACCENT2, type: ShadingType.CLEAR },
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text,
                  bold: true,
                  size: 18,
                  color: WHITE,
                  font: 'Arial',
                }),
              ],
            }),
          ],
        }),
    ),
  });
}

function dataRow(cells, widths, shade = false) {
  return new TableRow({
    children: cells.map(
      (text, i) =>
        new TableCell({
          borders,
          margins: cellMargins,
          width: { size: widths[i], type: WidthType.DXA },
          shading: {
            fill: shade ? LIGHT_GRAY : WHITE,
            type: ShadingType.CLEAR,
          },
          children: [
            new Paragraph({
              children: [
                new TextRun({ text: String(text), size: 18, font: 'Arial' }),
              ],
            }),
          ],
        }),
    ),
  });
}

function makeTable(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      headerRow(headers, widths),
      ...rows.map((r, i) => dataRow(r, widths, i % 2 === 1)),
    ],
  });
}

function infoBox(label, value) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [2200, 7160],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders,
            margins: cellMargins,
            width: { size: 2200, type: WidthType.DXA },
            shading: { fill: LIGHT_BLUE, type: ShadingType.CLEAR },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: label,
                    bold: true,
                    size: 18,
                    font: 'Arial',
                    color: ACCENT,
                  }),
                ],
              }),
            ],
          }),
          new TableCell({
            borders,
            margins: cellMargins,
            width: { size: 7160, type: WidthType.DXA },
            shading: { fill: WHITE, type: ShadingType.CLEAR },
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: value, size: 18, font: 'Arial' }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

const doc = new Document({
  numbering: {
    config: [
      {
        reference: 'bullets',
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: '\u2022',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 540, hanging: 360 } } },
          },
          {
            level: 1,
            format: LevelFormat.BULLET,
            text: '\u25E6',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 900, hanging: 360 } } },
          },
        ],
      },
    ],
  },
  styles: {
    default: { document: { run: { font: 'Arial', size: 20 } } },
    paragraphStyles: [
      {
        id: 'Heading1',
        name: 'Heading 1',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 32, bold: true, font: 'Arial', color: ACCENT },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 },
      },
      {
        id: 'Heading2',
        name: 'Heading 2',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 26, bold: true, font: 'Arial', color: ACCENT2 },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 },
      },
      {
        id: 'Heading3',
        name: 'Heading 3',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 22, bold: true, font: 'Arial', color: ACCENT },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 },
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
        },
      },
      children: [
        // ─── COVER PAGE ────────────────────────────────────────────────────
        new Paragraph({
          spacing: { before: 1440, after: 200 },
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: 'ZETHETA ALGORITHMS PRIVATE LIMITED',
              size: 20,
              color: '888888',
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          spacing: { before: 80, after: 800 },
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: 'Backend Engineering Internship Assessment — Project BE-6B',
              size: 20,
              color: '888888',
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          spacing: { before: 0, after: 200 },
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: 'EVENT-DRIVEN NOTIFICATION ENGINE',
              size: 52,
              bold: true,
              color: ACCENT,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          spacing: { before: 0, after: 800 },
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: 'WITH MULTI-CHANNEL DELIVERY',
              size: 36,
              bold: true,
              color: ACCENT2,
              font: 'Arial',
            }),
          ],
        }),

        makeTable(
          [],
          [
            [
              'Candidate',
              'Ukashatu Abdullahi',
              'Intern ID',
              '493556B',
              'Project Code',
              'BE-6B',
              'Submission Date',
              '22 June 2026',
            ].reduce((acc, val, i, arr) => {
              if (i % 2 === 0) acc.push([arr[i], arr[i + 1]]);
              return acc;
            }, []),
          ]
            .flat()
            .map((r) => r),
          [2400, 6960],
        ),

        spacer(),
        new Paragraph({
          spacing: { before: 200, after: 100 },
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: 'GitHub Repository',
              bold: true,
              size: 22,
              font: 'Arial',
              color: ACCENT2,
            }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: 'https://github.com/ZethetaIntern/BE-6B-NotificationEngine-UkashatuAbdullahi',
              size: 18,
              font: 'Courier New',
              color: ACCENT2,
            }),
          ],
        }),
        spacer(),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 300 },
          children: [
            new TextRun({
              text: 'All daily deliverables (Days 1\u201315) are included in this consolidated report.',
              size: 18,
              color: '666666',
              font: 'Arial',
            }),
          ],
        }),

        pageBreak(),

        // ─── SECTION 1: PROJECT OVERVIEW ──────────────────────────────────
        h1('1. Project Overview'),
        body(
          'The WealthBridge Notification Engine is a production-grade, event-driven backend designed for financial services. It processes 25+ financial event types and delivers notifications across five channels — SMS, Email, Push, WhatsApp, and In-App — while enforcing TRAI DND compliance, frequency capping, quiet hours, intelligent failover, and real-time analytics.',
        ),
        spacer(),
        h2('1.1 The Business Problem'),
        body(
          'The simulation scenario (Section B1) describes WealthBridge, a wealth management app with 4.2 million users suffering critical operational failures:',
        ),
        bullet('23.4% opt-out rate (industry average 8-12%)'),
        bullet(
          '18.7% of margin calls delivered after the auto-square-off deadline',
        ),
        bullet('4,282 TRAI DND violations per month'),
        bullet(
          'System crashes during market volatility causing 15\u201345 minute blackouts',
        ),
        bullet(
          'SMS costs of \u20B918.3 lakh/month from indiscriminate channel selection',
        ),
        spacer(),
        h2('1.2 Solution Targets'),
        makeTable(
          ['Metric', 'Failing (Before)', 'Target (This System)'],
          [
            ['Opt-Out Rate', '23.4%', '< 8% within 90 days'],
            ['Critical Notification P99 Latency', '47 seconds', '< 10 seconds'],
            ['DND Violations/Month', '4,282', 'Zero'],
            ['Delivery Rate (Critical)', '81.3%', '> 99.5%'],
            ['System Uptime', '97.2%', '99.95%'],
            ['Monthly SMS Cost', '\u20B918.3 lakh', '< \u20B96 lakh'],
            ['User Engagement (open rate)', '12.4%', '> 45%'],
          ],
          [3800, 2700, 2860],
        ),

        pageBreak(),

        // ─── SECTION 2: ARCHITECTURE ──────────────────────────────────────
        h1('2. System Architecture'),
        h2('2.1 Technology Stack'),
        makeTable(
          ['Layer', 'Technology', 'Justification'],
          [
            [
              'Runtime',
              'Node.js 20 LTS + TypeScript 5',
              'Strict typing, async I/O for high-throughput notification pipeline',
            ],
            [
              'Framework',
              'NestJS 10 + Fastify',
              'Modular architecture, 2\u00D7 throughput vs Express',
            ],
            [
              'Primary Event Bus',
              'Apache Kafka (Confluent 7.5)',
              '1M+ msg/sec, replay capability, consumer group parallelism',
            ],
            [
              'Delivery Queue',
              'RabbitMQ 3.12',
              'Priority queues, Dead Letter Exchanges, publisher confirms',
            ],
            [
              'Cache / State',
              'Redis 7',
              'Atomic INCR for freq capping, sorted sets for retry scheduling',
            ],
            [
              'Database',
              'PostgreSQL 15',
              'JSONB for payloads, partitioning, BRIN indexes for time-series',
            ],
            ['ORM', 'Prisma', 'Type-safe migrations, schema evolution'],
            [
              'Template Engine',
              'Handlebars.js',
              'Logic-less templates, localisation, A/B testing',
            ],
            [
              'Observability',
              'Prometheus + Grafana',
              '9 required metrics, real-time dashboards',
            ],
            [
              'Containerisation',
              'Docker + Docker Compose',
              'Reproducible environments, multi-stage builds',
            ],
          ],
          [2000, 2800, 4560],
        ),
        spacer(),
        h2('2.2 Event Processing Pipeline'),
        body('Every notification follows this deterministic pipeline:'),
        mono('Event Producer  \u2192  POST /api/v1/events'),
        mono(
          '                \u2192  Kafka (notification-events or notification-critical)',
        ),
        mono(
          '                \u2192  Engine: dedup check \u2192 DND check \u2192 freq cap \u2192 quiet hours',
        ),
        mono('                \u2192  Template rendering (Handlebars + i18n)'),
        mono('                \u2192  RabbitMQ (priority queue per channel)'),
        mono(
          '                \u2192  Delivery Worker \u2192 Provider (MSG91 / FCM / etc.)',
        ),
        mono('                \u2192  DLR Webhook \u2192 State: DELIVERED'),
        spacer(),
        h2('2.3 Kafka Topics'),
        makeTable(
          ['Topic', 'Partitions', 'Consumer Group', 'Purpose'],
          [
            [
              'notification-events',
              '6',
              'notification-cg',
              'Standard events (TXNX, SIPX, MKTX, REGX)',
            ],
            [
              'notification-critical',
              '6',
              'notification-critical-cg',
              'CRITICAL events only \u2014 dedicated resources',
            ],
            [
              'notification-dlq',
              '1',
              'dlq-processor-cg',
              'Failed events after max retries',
            ],
          ],
          [2800, 1600, 2400, 2560],
        ),
        spacer(),
        h2('2.4 Notification State Machine'),
        body(
          'Every notification transitions through a fully persisted state machine (all transitions logged to notification_state_log with timestamp and actor):',
        ),
        mono(
          'CREATED \u2192 ENRICHED \u2192 ROUTED \u2192 QUEUED \u2192 SENT \u2192 DELIVERED \u2192 READ',
        ),
        mono(
          '              \u2514\u2500 CAPPED        \u2514\u2500 FAILED \u2192 RETRYING \u2192 DLQ',
        ),
        mono(
          '              \u2514\u2500 QUIET              \u2514\u2500 BOUNCED',
        ),
        mono('              \u2514\u2500 DND'),
        mono('              \u2514\u2500 DEDUPLICATED'),

        pageBreak(),

        // ─── SECTION 3: EVENT TAXONOMY ────────────────────────────────────
        h1('3. Financial Event Taxonomy (25+ Event Types)'),
        h2('3.1 Category 1: Transaction Events (TXNX-*)'),
        makeTable(
          ['Event Code', 'Name', 'Urgency', 'Channels', 'Max Latency'],
          [
            [
              'TXNX-001',
              'Buy Order Executed',
              'HIGH',
              'SMS, Push, Email',
              '< 30 seconds',
            ],
            [
              'TXNX-002',
              'Sell Order Executed',
              'HIGH',
              'SMS, Push, Email',
              '< 30 seconds',
            ],
            ['TXNX-003', 'Order Rejected', 'HIGH', 'Push, SMS', '< 15 seconds'],
            [
              'TXNX-004',
              'Dividend Credited',
              'MEDIUM',
              'Email, Push',
              '< 1 hour',
            ],
            [
              'TXNX-005',
              'Funds Deposited',
              'HIGH',
              'SMS, Push',
              '< 60 seconds',
            ],
          ],
          [1600, 2600, 1600, 2200, 1360],
        ),
        spacer(),
        h2('3.2 Category 2: Risk & Margin Events (RISK-*)'),
        makeTable(
          ['Event Code', 'Name', 'Urgency', 'Channels', 'Max Latency'],
          [
            [
              'RISK-001',
              'Margin Call Warning',
              'CRITICAL',
              'SMS, Push',
              '< 10 seconds',
            ],
            [
              'RISK-002',
              'Margin Shortfall',
              'CRITICAL',
              'SMS, Push, Email',
              '< 5 seconds',
            ],
            [
              'RISK-003',
              'Position Squared Off',
              'CRITICAL',
              'SMS, Push, Email',
              '< 15 seconds',
            ],
            [
              'RISK-004',
              'Portfolio Risk Alert',
              'HIGH',
              'Push, Email',
              '< 5 minutes',
            ],
            [
              'RISK-005',
              'Concentration Alert',
              'MEDIUM',
              'Email, In-App',
              '< 1 hour',
            ],
          ],
          [1600, 2600, 1600, 2200, 1360],
        ),
        spacer(),
        h2('3.3 Category 3: SIP & Investment Events (SIPX-*)'),
        makeTable(
          ['Event Code', 'Name', 'Urgency', 'Channels', 'Max Latency'],
          [
            [
              'SIPX-001',
              'SIP Due Reminder',
              'MEDIUM',
              'Push, WhatsApp',
              'T-3 days',
            ],
            ['SIPX-002', 'SIP Executed', 'HIGH', 'SMS, Email', '< 2 hours'],
            [
              'SIPX-003',
              'SIP Failed',
              'HIGH',
              'SMS, Push, Email',
              '< 30 minutes',
            ],
            [
              'SIPX-004',
              'SIP Step-Up Reminder',
              'LOW',
              'Email, In-App',
              'Annual',
            ],
            [
              'SIPX-005',
              'Goal Milestone Reached',
              'LOW',
              'Push, In-App',
              '< 4 hours',
            ],
          ],
          [1600, 2600, 1600, 2200, 1360],
        ),
        spacer(),
        h2('3.4 Category 4: Market & Price Events (MKTX-*)'),
        makeTable(
          ['Event Code', 'Name', 'Urgency', 'Channels', 'Max Latency'],
          [
            [
              'MKTX-001',
              'Price Alert Triggered',
              'HIGH',
              'Push, SMS',
              '< 15 seconds',
            ],
            [
              'MKTX-002',
              'Circuit Breaker Hit',
              'CRITICAL',
              'Push, SMS',
              '< 10 seconds',
            ],
            ['MKTX-003', 'Market Open/Close', 'LOW', 'Push', 'At event time'],
            [
              'MKTX-004',
              '52-Week High/Low',
              'MEDIUM',
              'Push, Email',
              '< 30 minutes',
            ],
            [
              'MKTX-005',
              'Earnings Announcement',
              'MEDIUM',
              'Email, In-App',
              'T-1 day',
            ],
          ],
          [1600, 2600, 1600, 2200, 1360],
        ),
        spacer(),
        h2('3.5 Category 5: Regulatory & Compliance Events (REGX-*)'),
        makeTable(
          ['Event Code', 'Name', 'Urgency', 'Channels', 'Max Latency'],
          [
            [
              'REGX-001',
              'KYC Expiry Warning',
              'HIGH',
              'SMS, Email, Push',
              'T-30, T-15, T-7',
            ],
            [
              'REGX-002',
              'Nominee Update Reminder',
              'MEDIUM',
              'Email, Push',
              'Quarterly',
            ],
            ['REGX-003', 'Contract Note Generated', 'HIGH', 'Email', 'T+1 EOD'],
            [
              'REGX-004',
              'Tax Statement Available',
              'MEDIUM',
              'Email, In-App',
              'Quarterly',
            ],
            [
              'REGX-005',
              'Regulatory Policy Change',
              'LOW',
              'Email',
              '< 24 hours',
            ],
          ],
          [1600, 2600, 1600, 2200, 1360],
        ),

        pageBreak(),

        // ─── SECTION 4: KEY IMPLEMENTATIONS ──────────────────────────────
        h1('4. Key Implementation Details'),

        h2('4.1 Channel Routing Decision Engine'),
        body('The routing engine evaluates four priorities in sequence:'),
        bullet(
          'Priority 1 — Regulatory Mandate (non-negotiable): SEBI-mandated channels MUST be used. RISK-001 always gets SMS + Push regardless of user preference.',
        ),
        bullet(
          'Priority 2 — User Preferences: Per-category, per-channel configuration with 4-layer hierarchy (system defaults \u2192 segment \u2192 user explicit \u2192 regulatory override).',
        ),
        bullet(
          'Priority 3 — Delivery Optimisation: Prefer channels with higher historical delivery rate per user. Per-user, per-channel engagement metrics maintained in Redis.',
        ),
        bullet(
          'Priority 4 — Cost Optimisation: When delivery characteristics are equal, route non-urgent notifications to cheaper channels (in-app, email over SMS).',
        ),
        spacer(),

        h2('4.2 TRAI DND Compliance'),
        bullet(
          'DND Registry Lookup: Every SMS checks Redis DND cache (24h TTL) before dispatch. Database fallback if cache miss.',
        ),
        bullet(
          'DND check happens at the LAST possible moment before SMS dispatch \u2014 not during routing \u2014 to prevent race conditions.',
        ),
        bullet(
          'TRANSACTIONAL classification: margin calls, order confirmations, OTPs are DND-exempt.',
        ),
        bullet(
          'PROMOTIONAL classification: SIP step-up suggestions, new fund recommendations are blocked for DND-registered users.',
        ),
        bullet(
          'Immutable consent audit log with timestamps stored in consent_records table.',
        ),
        spacer(),

        h2('4.3 Frequency Capping (Multi-Dimensional)'),
        makeTable(
          ['Cap Dimension', 'Limit', 'Window', 'Override'],
          [
            [
              'Global per-user daily',
              '12 notifications/day',
              'Rolling 24 hours',
              'CRITICAL events bypass',
            ],
            [
              'Per-channel daily',
              'SMS: 5, Push: 8, Email: 3',
              'Rolling 24 hours',
              'Regulatory mandates bypass',
            ],
            [
              'Per-category hourly',
              'Max 3 per category/hour',
              'Rolling 60 minutes',
              'Margin calls always sent',
            ],
            [
              'Cooldown between same-type',
              'Min 15 minutes gap',
              'Per event type',
              'Price alerts configurable',
            ],
            [
              'Weekly digest threshold',
              'If > 8/day, suggest digest',
              'Rolling 7 days',
              'User can override',
            ],
          ],
          [2600, 2400, 2000, 2360],
        ),
        body(
          'Cap evaluation order (most-specific first): Cooldown \u2192 Category hourly \u2192 Channel daily \u2192 Global daily. See Document Error Log for why this differs from the spec.',
        ),
        spacer(),

        h2('4.4 Retry Strategy (Exponential Backoff with Jitter)'),
        mono(
          'retryDelay = min(baseDelay \u00D7 2^(attempt-1) + randomJitter(0, 1000ms), maxDelay)',
        ),
        spacer(),
        makeTable(
          ['Priority', 'Max Retries', 'Base Delay', 'Max Delay'],
          [
            ['CRITICAL (1)', '10', '500ms', '60 seconds'],
            ['HIGH (2)', '5', '1 second', '5 minutes'],
            ['MEDIUM (3)', '3', '5 seconds', '30 minutes'],
            ['LOW (5)', '2', '30 seconds', '2 hours'],
          ],
          [2340, 2340, 2340, 2340],
        ),
        spacer(),

        h2('4.5 Circuit Breaker Pattern'),
        bullet(
          'Three states: CLOSED (normal), OPEN (failing), HALF_OPEN (testing recovery)',
        ),
        bullet('Opens after 5 failures within a 60-second sliding window'),
        bullet('Stays OPEN for 60 seconds before transitioning to HALF_OPEN'),
        bullet('Closes after 2 consecutive successes in HALF_OPEN'),
        bullet(
          'Failover chain: MSG91 \u2192 Twilio (SMS); FCM \u2192 In-App (Push)',
        ),
        bullet('Idempotency keys prevent duplicate delivery during failover'),
        spacer(),

        h2('4.6 Template Engine'),
        bullet(
          'Handlebars.js with custom helpers: formatCurrency (Indian locale \u20B91,00,000), formatDate, truncateSms',
        ),
        bullet(
          '25 event type templates across all channels (SMS, Email, Push, WhatsApp, In-App)',
        ),
        bullet(
          '5-language localisation: English, Hindi (\u0939\u093F\u0928\u094D\u0926\u0940), Marathi, Tamil, Telugu',
        ),
        bullet(
          'Fallback chain: requested locale \u2192 English \u2192 hardcoded default',
        ),
        bullet(
          'SMS truncation: preserves meaning within 160 chars, never truncates financial figures',
        ),
        bullet(
          'A/B testing with deterministic SHA-256 bucketing and two-proportion z-test for statistical significance',
        ),

        pageBreak(),

        // ─── SECTION 5: API CONTRACTS ─────────────────────────────────────
        h1('5. API Contract Reference (Appendix A)'),

        h2('5.1 Event Ingestion'),
        mono('POST /api/v1/events'),
        mono('Authorization: Bearer <JWT>'),
        spacer(),
        h3('Request Body'),
        mono('{'),
        mono('  "eventType": "RISK-001",'),
        mono('  "eventId": "EVT-2025-03-19-MC-847291",'),
        mono('  "sourceSystem": "margin_engine",'),
        mono('  "timestamp": "2025-03-19T10:15:23.456Z",'),
        mono('  "priority": 1,'),
        mono('  "userId": "usr_a1b2c3d4-e5f6-7890-abcd-ef1234567890",'),
        mono('  "payload": { "shortfall_amount": 125000.00, ... },'),
        mono('  "idempotencyKey": "margin-call-usr-001-2025-03-19"'),
        mono('}'),
        spacer(),
        h3('Response (202 Accepted)'),
        mono('{'),
        mono(
          '  "notification_id": "ntf_98765432-abcd-1234-ef56-789012345678",',
        ),
        mono('  "event_id": "EVT-2025-03-19-MC-847291",'),
        mono('  "status": "CREATED",'),
        mono('  "channels_targeted": ["sms", "push", "in_app"],'),
        mono('  "estimated_delivery_ms": 3000,'),
        mono('  "created_at": "2025-03-19T10:15:23.512Z"'),
        mono('}'),
        spacer(),

        h2('5.2 Complete Endpoint List'),
        makeTable(
          ['Method', 'Path', 'Description', 'Auth'],
          [
            [
              'POST',
              '/api/v1/auth/login',
              'Obtain JWT access token (1h TTL)',
              'Service Key',
            ],
            [
              'POST',
              '/api/v1/auth/refresh',
              'Refresh access token with rotation',
              'Refresh Token',
            ],
            [
              'POST',
              '/api/v1/events',
              'Ingest financial event for processing',
              'ADMIN/SERVICE',
            ],
            [
              'GET',
              '/api/v1/notifications/:id',
              'Get notification status + compliance block',
              'ADMIN/OPERATOR',
            ],
            [
              'GET',
              '/api/v1/users/:id/notifications',
              'List notifications for a user',
              'ADMIN/OPERATOR',
            ],
            [
              'PATCH',
              '/api/v1/notifications/:id/read',
              'Mark notification as read',
              'ADMIN',
            ],
            [
              'GET',
              '/api/v1/users/:id/preferences',
              'Get user notification preferences',
              'ADMIN/OPERATOR',
            ],
            [
              'PUT',
              '/api/v1/users/:id/preferences',
              'Update user preferences (10/min rate limit)',
              'ADMIN',
            ],
            [
              'DELETE',
              '/api/v1/users/:id/data',
              'GDPR right-to-erasure',
              'ADMIN',
            ],
            [
              'GET',
              '/api/v1/analytics/delivery-rates',
              'Delivery rates by channel and period',
              'ADMIN/OPERATOR',
            ],
            [
              'GET',
              '/api/v1/analytics/channel-performance',
              'Per-channel performance metrics',
              'ADMIN/OPERATOR',
            ],
            [
              'GET',
              '/api/v1/analytics/opt-out-trends',
              'Rolling 30-day opt-out trends',
              'ADMIN/OPERATOR',
            ],
            ['GET', '/api/v1/dlq', 'List DLQ entries', 'ADMIN/OPERATOR'],
            [
              'PATCH',
              '/api/v1/dlq/:id/resolve',
              'Resolve DLQ entry (retry/discard)',
              'ADMIN',
            ],
            [
              'POST',
              '/api/v1/notifications/preview',
              'Preview notification before opt-in (Bonus)',
              'ADMIN',
            ],
            [
              'POST',
              '/webhooks/dlr/sms/msg91',
              'MSG91 delivery receipt (HMAC-SHA256)',
              'Signature',
            ],
            [
              'POST',
              '/webhooks/dlr/sms/twilio',
              'Twilio status callback (HMAC-SHA1)',
              'Signature',
            ],
            [
              'POST',
              '/webhooks/dlr/push/fcm',
              'FCM read receipt (HMAC-SHA256)',
              'Signature',
            ],
            [
              'POST',
              '/webhooks/dlr/whatsapp',
              'WhatsApp status update (X-Hub-Sig-256)',
              'Signature',
            ],
            ['GET', '/health', 'Full system health check', 'Public'],
            ['GET', '/ready', 'Readiness probe', 'Public'],
            ['GET', '/live', 'Liveness probe', 'Public'],
            ['GET', '/metrics', 'Prometheus metrics endpoint', 'Public'],
            ['GET', '/api-docs', 'Swagger UI', 'Public'],
          ],
          [800, 3400, 3000, 2160],
        ),

        pageBreak(),

        // ─── SECTION 6: SECURITY ──────────────────────────────────────────
        h1('6. Security Implementation (Section A10)'),
        h2('6.1 Authentication & Authorisation'),
        bullet(
          'JWT-based authentication on all endpoints (globally wired via APP_GUARD in SharedModule)',
        ),
        bullet(
          'Three RBAC roles: ADMIN (full access), OPERATOR (read-only analytics), SERVICE (machine-to-machine)',
        ),
        bullet('JWT access token TTL: 1 hour (spec maximum)'),
        bullet(
          'Refresh token rotation: new access + refresh token issued on each refresh request',
        ),
        bullet(
          'Public routes (bypass JWT): /health, /ready, /live, /metrics, /auth/login, /auth/refresh, /webhooks/*',
        ),
        spacer(),
        h2('6.2 Rate Limiting (Sliding Window)'),
        bullet('100 requests/minute for standard API calls'),
        bullet(
          '1,000 requests/minute for webhook callbacks (delivery receipts)',
        ),
        bullet('10 requests/minute for preference updates'),
        bullet(
          'Implemented via @nestjs/throttler with ThrottlerGuard registered globally',
        ),
        spacer(),
        h2('6.3 Webhook HMAC Signature Validation'),
        bullet('MSG91: HMAC-SHA256 validated via X-MSG91-Signature header'),
        bullet(
          'Twilio: HMAC-SHA1 validated via X-Twilio-Signature header (Twilio standard)',
        ),
        bullet('FCM: HMAC-SHA256 validated via X-FCM-Signature header'),
        bullet(
          'WhatsApp: HMAC-SHA256 validated via X-Hub-Signature-256 header (Meta standard)',
        ),
        bullet(
          'All validations use crypto.timingSafeEqual() to prevent timing attacks',
        ),
        spacer(),
        h2('6.4 Data Privacy'),
        bullet(
          'PII redaction in all logs: phone numbers, emails, authorization headers redacted to [REDACTED]',
        ),
        bullet(
          'GDPR right-to-erasure: DELETE /api/v1/users/:id/data scrubs personalisation_data, deletes consent records, anonymises user row',
        ),
        bullet(
          '90-day data retention: daily cron at 02:00 UTC scrubs personalisation_data older than 90 days',
        ),
        bullet(
          'Webhook credentials stored in environment variables, never committed to source',
        ),

        pageBreak(),

        // ─── SECTION 7: DATABASE ──────────────────────────────────────────
        h1('7. Database Design (Section A8)'),
        h2('7.1 Tables'),
        makeTable(
          ['Table', 'Purpose', 'Key Indexes'],
          [
            [
              'users',
              'User identity, DND status, language, quiet hours',
              'email UNIQUE, phone UNIQUE, account_type',
            ],
            [
              'notifications',
              'Central notification record per channel (partitioned monthly)',
              '(user_id, status, channel); BRIN(created_at); GIN(personalisation_data)',
            ],
            [
              'notification_state_log',
              'Immutable audit trail of all state transitions',
              'notification_id, created_at',
            ],
            [
              'delivery_attempts',
              'Per-attempt delivery metadata with latency',
              'notification_id, (provider, attempted_at)',
            ],
            [
              'dead_letter_queue',
              'Failed notifications after max retries',
              'notification_id UNIQUE, (resolved, created_at)',
            ],
            [
              'user_preferences',
              'Per-category, per-channel notification settings',
              '(userId, eventCategory, channel) UNIQUE',
            ],
            [
              'consent_records',
              'Immutable DND opt-in/opt-out audit log',
              '(userId, channel), granted_at',
            ],
            [
              'templates',
              'Template definitions with versioning',
              '(eventType, version) UNIQUE',
            ],
            [
              'provider_health',
              'Circuit breaker state per provider',
              'provider UNIQUE',
            ],
          ],
          [2200, 3500, 3660],
        ),
        spacer(),
        h2('7.2 Index Strategy'),
        makeTable(
          ['Index', 'Type', 'Purpose (spec Section A8.2)'],
          [
            [
              '(user_id, status, channel)',
              'Composite B-tree',
              'User notification queries',
            ],
            [
              "status WHERE IN ('QUEUED','RETRYING')",
              'Partial B-tree',
              'Worker polling queries',
            ],
            [
              'created_at',
              'BRIN',
              'Time-range analytics scans on partitioned table',
            ],
            ['personalisation_data', 'GIN', 'JSONB attribute queries'],
            [
              '(event_type, created_at)',
              'Composite B-tree',
              'Analytics aggregations',
            ],
            [
              'notification_id in state_log',
              'B-tree',
              'Distributed trace lookups',
            ],
          ],
          [3200, 2000, 4160],
        ),

        pageBreak(),

        // ─── SECTION 8: OBSERVABILITY ─────────────────────────────────────
        h1('8. Monitoring & Observability (Section A11)'),
        h2('8.1 Prometheus Metrics (All 9 Required)'),
        makeTable(
          ['Metric Name', 'Type', 'Labels'],
          [
            [
              'notification_events_received_total',
              'Counter',
              'event_type, priority',
            ],
            [
              'notification_delivery_total',
              'Counter',
              'channel, provider, status',
            ],
            [
              'notification_delivery_latency_seconds',
              'Histogram',
              'channel, priority',
            ],
            [
              'notification_frequency_cap_hits_total',
              'Counter',
              'cap_type, event_type',
            ],
            ['notification_dnd_blocks_total', 'Counter', 'classification'],
            ['notification_dlq_depth', 'Gauge', '(none)'],
            ['notification_retry_total', 'Counter', 'attempt, provider'],
            ['kafka_consumer_lag', 'Gauge', 'topic, partition, consumer_group'],
            [
              'delivery_provider_circuit_state',
              'Gauge (0=CLOSED,1=HALF,2=OPEN)',
              'provider, channel',
            ],
          ],
          [3600, 2000, 3760],
        ),
        spacer(),
        h2('8.2 Alerting Rules'),
        makeTable(
          ['Alert', 'Condition', 'Severity'],
          [
            ['HighDLQDepth', 'DLQ depth > 100 for > 5 minutes', 'CRITICAL'],
            [
              'ProviderCircuitOpen',
              'Any provider circuit breaker OPEN',
              'HIGH',
            ],
            [
              'DeliveryLatencySpike',
              'P99 latency > 30s for CRITICAL events',
              'CRITICAL',
            ],
            [
              'HighFailureRate',
              'Delivery failure rate > 5% in 10-minute window',
              'HIGH',
            ],
            [
              'KafkaConsumerLag',
              'Consumer lag > 10,000 messages for > 5 minutes',
              'HIGH',
            ],
            ['DNDViolationDetected', 'Any DND violation detected', 'CRITICAL'],
          ],
          [2800, 3500, 3060],
        ),
        spacer(),
        h2('8.3 Health Check Endpoints'),
        bullet(
          '/health \u2014 Full system health (PostgreSQL, Redis, Kafka, RabbitMQ). Returns 503 if any component down.',
        ),
        bullet('/ready \u2014 Readiness probe for container orchestrators.'),
        bullet(
          '/live \u2014 Liveness probe. Returns 200 as long as process is alive.',
        ),
        bullet('/metrics \u2014 Prometheus text format scrape endpoint.'),

        pageBreak(),

        // ─── SECTION 9: PERFORMANCE ───────────────────────────────────────
        h1('9. Performance Benchmarks (Day 11)'),
        h2('9.1 Load Test Results'),
        makeTable(
          ['Scenario', 'Throughput', 'P50', 'P95', 'P99', 'Failures'],
          [
            [
              'Market Crash (450K alerts, 30 min)',
              '545 req/s',
              '5.0ms',
              '10.4ms',
              '10.9ms',
              '0%',
            ],
            [
              'Multi-Language Broadcast (4.2M users, 4h)',
              '30 req/s (test)',
              '2.7ms',
              '3.8ms',
              '\u2014',
              '0%',
            ],
            [
              'Provider Outage + Failover',
              '205 req/s',
              '2.5ms',
              '5.6ms',
              '\u2014',
              '0%',
            ],
          ],
          [2900, 1800, 1100, 1100, 1100, 1360],
        ),
        spacer(),
        h2('9.2 SLA Compliance'),
        bullet(
          'RISK-001 (Margin Call): P99 = 10.9ms vs SLA of 10,000ms \u2014 921\u00D7 faster than requirement',
        ),
        bullet(
          'MKTX-001 (Price Alert): P95 = 10.4ms vs SLA of 15,000ms \u2014 1,443\u00D7 faster than requirement',
        ),
        bullet(
          'Scaling projection: 2M daily notifications require 1 instance; 20M daily require Redis Cluster',
        ),
        bullet(
          'Bottleneck: Redis connection pool under peak (resolved with pre-warming and maxRetriesPerRequest: 3)',
        ),

        pageBreak(),

        // ─── SECTION 10: BONUS FEATURES ───────────────────────────────────
        h1('10. Bonus Features (Section B3.4 \u2014 All 4 Implemented)'),

        h2('10.1 A/B Testing with Statistical Significance'),
        bullet(
          'Deterministic SHA-256 bucketing: consistent variant assignment per user per event type',
        ),
        bullet(
          'Conversion tracking: exposure, delivery, and read events recorded per variant in Redis',
        ),
        bullet(
          'Statistical significance: two-proportion z-test at 95% confidence (z-critical = 1.96)',
        ),
        bullet(
          'Returns: deliveryRatePValue, readRatePValue, isSignificant, confidenceLevel, winner',
        ),
        bullet(
          'Minimum sample size: 30 exposures per variant before significance is calculated',
        ),
        bullet('Endpoint: GET /api/v1/templates/:eventType/ab-performance'),
        spacer(),

        h2('10.2 Notification Preview API'),
        bullet('Endpoint: POST /api/v1/notifications/preview'),
        bullet(
          'Renders all channel templates for a given event type and user before opt-in',
        ),
        bullet(
          'Returns rendered SMS, Email subject, Push title/body, WhatsApp message, In-App content',
        ),
        bullet(
          'Respects user language preference and personalisation fields from sample payload',
        ),
        spacer(),

        h2('10.3 Send-Time Optimisation'),
        bullet(
          'Per-user hourly engagement scoring: Redis hash user:{userId}:engagement with 24 hour slots',
        ),
        bullet(
          'Exponential decay: recent engagement counts more than stale history',
        ),
        bullet(
          'Minimum 10 samples required before STO activates (returns INSUFFICIENT_DATA otherwise)',
        ),
        bullet('CRITICAL and HIGH priority events bypass STO entirely'),
        bullet('Maximum delay cap: 4 hours to prevent indefinite postponement'),
        spacer(),

        h2('10.4 Real-Time WebSocket Dashboard'),
        bullet('Socket.io gateway at /dashboard'),
        bullet(
          'Channels: firehose (all notifications), user:{id} (per-user), metrics:stats (system counters)',
        ),
        bullet(
          'Broadcasts: notification:state on every state transition, stats:update every 5 seconds',
        ),
        bullet('JWT-authenticated WebSocket connections via ws-jwt.guard.ts'),

        pageBreak(),

        // ─── SECTION 11: DAILY LOG ────────────────────────────────────────
        h1('11. Daily Progress Log (Days 1\u201315)'),
        body(
          'All daily deliverables consolidated here per the Part D submission instructions. AI acceleration is noted per Section E4 guidelines.',
        ),
        spacer(),

        ...[
          [
            'Day 1',
            'Project Setup & Architecture Design',
            [
              'GitHub repository created: BE-6B-NotificationEngine-UkashatuAbdullahi',
              'NestJS/TypeScript project initialised with strict: true, noImplicitAny: true',
              'Docker Compose: PostgreSQL 15, Redis 7, Kafka (Confluent 7.5), RabbitMQ 3.12',
              'docs/architecture.md with C4 system context, container, and component diagrams',
              'docs/event-taxonomy.yaml with all 25 event type definitions',
              'OpenAPI 3.0 contracts defined for all internal services',
              'Git commit: feat: initial project setup with Docker Compose and architecture docs',
              'AI: Docker Compose boilerplate scaffolded with AI, reviewed and customised',
            ],
          ],
          [
            'Day 2',
            'Database Schema & Event Models',
            [
              'Prisma migrations for all 11 tables',
              'Table partitioning by created_at (monthly), BRIN + GIN + partial indexes',
              'Seed data: 1,000 test users with varied preferences, languages, DND status',
              'TypeScript interfaces for all 25+ event types with strict typing',
              'Zod validation for all event payloads',
              'Unit tests for event validators (20+ test cases)',
            ],
          ],
          [
            'Day 3',
            'Event Ingestion Pipeline',
            [
              'Kafka topics: notification-events (6 partitions), notification-critical, notification-dlq',
              'Idempotent Kafka producer (enable.idempotence=true)',
              'Consumer groups with manual offset management (at-least-once delivery)',
              '4-priority weighted routing engine (regulatory \u2192 user \u2192 delivery \u2192 cost)',
              'Redis SHA-256 fingerprinting for event deduplication',
            ],
          ],
          [
            'Day 4',
            'Template Engine & Personalisation',
            [
              'Handlebars engine with formatCurrency, formatDate, truncateSms helpers',
              '25 event type templates across all channels',
              '5-language localisation (en, hi, mr, ta, te) with fallback chain',
              'SMS truncation logic (160 chars, never truncates financial figures)',
              'A/B testing variant resolution',
            ],
          ],
          [
            'Day 5',
            'User Preference System',
            [
              'GET/PUT /api/v1/users/:id/preferences',
              '4-layer hierarchy resolver: system defaults \u2192 segment \u2192 user \u2192 regulatory override',
              'Redis caching with TTL invalidation on update',
              'Digest mode: batch low-priority notifications hourly or daily',
            ],
          ],
          [
            'Day 6',
            'DND Compliance & Frequency Capping',
            [
              'DND check at last moment before SMS dispatch (not routing) \u2014 prevents race conditions',
              'TRANSACTIONAL/PROMOTIONAL classification for all 25 event types',
              'Multi-dimensional frequency capping using Redis atomic INCR',
              'Quiet hours: 21:00\u201308:00 IANA timezone, CRITICAL bypass, morning digest',
              '25+ test cases covering all edge cases',
            ],
          ],
          [
            'Day 7',
            'Multi-Channel Delivery Providers',
            [
              'DeliveryProvider interface per spec Section A3.3',
              'MSG91 + Twilio (SMS failover), Nodemailer + Ethereal (email), FCM (push)',
              'WhatsApp Cloud API, In-App via Socket.io',
              'Circuit breaker: CLOSED/OPEN/HALF_OPEN, 5-failure/60s threshold',
            ],
          ],
          [
            'Day 8',
            'Delivery Routing & Failover Engine',
            [
              'Priority-weighted channel scoring with multi-channel fan-out',
              'Provider failover: MSG91 \u2192 Twilio, FCM \u2192 In-App',
              'Idempotency checks prevent duplicate delivery during failover',
              'Delivery acknowledgement tracking in delivery_attempts table',
            ],
          ],
          [
            'Day 9',
            'Retry Strategy & Dead Letter Queue',
            [
              'Exponential backoff: min(baseDelay \u00D7 2^(attempt-1) + jitter(0,1000ms), maxDelay)',
              'Priority retry configs (CRITICAL 10/500ms, HIGH 5/1s, MEDIUM 3/5s, LOW 2/30s)',
              'Redis sorted sets for retry scheduling (ZADD with timestamp as score)',
              'DLQ API: GET /dlq, PATCH /dlq/:id/resolve (retry | discard | manual_send)',
            ],
          ],
          [
            'Day 10',
            'Analytics Pipeline',
            [
              'Real-time sliding window counters in Redis',
              'Analytics API: /delivery-rates, /channel-performance, /opt-out-trends',
              'All 9 Prometheus metrics per spec Section A11.1',
              'Cost analytics: per-channel, per-event-type cost tracking in paisa',
            ],
          ],
          [
            'Day 11',
            'Load Testing & Performance Optimisation',
            [
              'k6 test scripts: market crash (450K in 30min), multi-language broadcast, provider outage',
              'Results: 545 req/s, P99 10.9ms on margin calls (921\u00D7 faster than 10s SLA)',
              'Connection pooling: PostgreSQL max 20, Redis max 50',
              'Kafka: 6 partitions, 6 consumer instances per group',
            ],
          ],
          [
            'Day 12',
            'Error Handling, Logging & Monitoring',
            [
              'Pino structured JSON logging with correlation IDs propagated through Kafka headers',
              'PII redaction: phones, emails, authorization headers \u2192 [REDACTED]',
              'GlobalExceptionFilter with error classification (transient/permanent/validation)',
              'Graceful shutdown: drains in-flight queues before SIGTERM',
            ],
          ],
          [
            'Day 13',
            'API Documentation & Testing',
            [
              'OpenAPI 3.0 specification at docs/api-specification.yaml',
              'Swagger UI at /api-docs',
              'Postman collection at docs/postman-collection.json (20+ requests with test scripts)',
              '12 test suites, 124 tests, 100% pass rate',
            ],
          ],
          [
            'Day 14',
            'Containerisation, CI/CD & Security',
            [
              'Multi-stage Dockerfile: builder \u2192 production, non-root user nestjs',
              'GitHub Actions CI: lint \u2192 test \u2192 build \u2192 coverage \u2192 npm audit \u2192 secrets scan',
              'JWT globally enforced (APP_GUARD), RBAC: ADMIN/OPERATOR/SERVICE',
              'Rate limiting: 100/min standard, 1000/min webhooks, 10/min preferences',
              'Webhook HMAC-SHA256/SHA1 signature validation for all 4 providers',
            ],
          ],
          [
            'Day 15',
            'Final Documentation, Bonus Features & Transfer',
            [
              'All four bonus features completed (A/B testing, preview, STO, WebSocket dashboard)',
              'GDPR erasure: DELETE /api/v1/users/:id/data',
              '90-day data retention cron (daily at 02:00 UTC)',
              'Webhook DLR controllers for MSG91, Twilio, FCM, WhatsApp',
              'All datasets: 100K events, 10K users, 5K failures, 2K complaints, 12.8K DND violations',
              'Repository transferred to @ZethetaIntern',
              'AI: Claude used for code review, error diagnosis, and spec compliance auditing',
            ],
          ],
        ].flatMap(([day, title, items]) => [
          h3(`${day} \u2014 ${title}`),
          ...items.map((i) => bullet(i)),
          spacer(),
        ]),

        pageBreak(),

        // ─── SECTION 12: DOCUMENT ERROR LOG ──────────────────────────────
        h1('12. Document Error Log (Section A13 \u2014 Bonus)'),
        body(
          'Five deliberate errors were identified in the specification. Each is documented with location, analysis, and implementation decision.',
        ),
        spacer(),

        h2('Error 1 \u2014 Retry Formula Off-By-One (Section A9.1)'),
        body(
          'Spec states: retryDelay = min(baseDelay \u00D7 2^attempt + jitter, maxDelay) with comment "Attempt 1: ~1-2 seconds"',
        ),
        body(
          'Problem: With baseDelay=1000ms and attempt=1, the formula gives 1000 \u00D7 2^1 = 2000ms, not 1\u20132 seconds.',
        ),
        body(
          'Fix implemented: min(baseDelay \u00D7 2^(attempt-1) + jitter, maxDelay) so attempt 1 correctly gives ~1000ms.',
        ),
        spacer(),

        h2(
          'Error 2 \u2014 Invalid PRIMARY KEY Expression in user_preferences (Section A5.2)',
        ),
        body(
          "Spec states: PRIMARY KEY (user_id, event_category, COALESCE(event_type, '*'), channel)",
        ),
        body(
          'Problem: PostgreSQL does not allow function calls inside PRIMARY KEY declarations. This DDL fails with a syntax error.',
        ),
        body(
          "Fix implemented: Prisma composite unique index @@unique([userId, eventCategory, channel]) with event_type VARCHAR NOT NULL DEFAULT '*'.",
        ),
        spacer(),

        h2(
          'Error 3 \u2014 MKTX-003 Urgency vs Channel Contradiction (Section A2.5)',
        ),
        body(
          'Spec assigns MKTX-003 (Market Open/Close) as LOW urgency with Push as the only channel.',
        ),
        body(
          'Problem: Push is designed for high-attention notifications. Routing LOW-urgency content to Push contradicts Section A3.2 Priority 4 (cost optimisation) and drives opt-outs.',
        ),
        body(
          'Fix implemented: MKTX-003 routed to In-App primary with email digest secondary for LOW urgency events.',
        ),
        spacer(),

        h2(
          'Error 4 \u2014 Frequency Cap Dimensions Are Mathematically Inconsistent (Section A6.2)',
        ),
        body(
          'Spec lists Global daily cap of 12, and per-category hourly cap of 3.',
        ),
        body(
          'Problem: 5 categories \u00D7 3/hour \u00D7 6.25 market hours = 93.75 max notifications/day. The 12/day global cap fires long before the per-category cap becomes meaningful, making it effectively unreachable in normal operation.',
        ),
        body(
          'Fix implemented: Caps evaluated most-specific first (cooldown \u2192 category hourly \u2192 channel daily \u2192 global daily) to ensure all dimensions are meaningful.',
        ),
        spacer(),

        h2(
          'Error 5 \u2014 REGX-005 Retry Budget Cannot Meet 24-Hour SLA (Sections A2.6 + A9.1)',
        ),
        body(
          'REGX-005 has a < 24-hour max latency SLA but is classified as LOW priority.',
        ),
        body(
          'Problem: LOW retry policy (2 retries, 30s base delay) exhausts its budget in ~90 seconds and moves to DLQ, making the 24-hour SLA impossible to achieve.',
        ),
        body(
          'Fix implemented: REGX-005 promoted to MEDIUM priority in the routing engine, aligning retry budget with the required delivery SLA.',
        ),

        pageBreak(),

        // ─── SECTION 13: DATASETS ─────────────────────────────────────────
        h1('13. Simulation Datasets (Section B4)'),
        makeTable(
          ['File', 'Rows', 'Required Fields'],
          [
            [
              'data/notification_events.csv',
              '100,000',
              'event_id, event_type, user_id, timestamp, priority, source_system, payload (JSON), channel_preference',
            ],
            [
              'data/user_profiles.csv',
              '10,000',
              'user_id, name, phone, email, language, timezone, dnd_status, dnd_categories, account_type, risk_profile, notification_preferences, quiet_hours_start, quiet_hours_end, created_at',
            ],
            [
              'data/delivery_failures.csv',
              '5,000',
              'notification_id, channel, provider, failure_code, failure_reason, retry_count, final_status, timestamp',
            ],
            [
              'data/user_complaints.csv',
              '2,000',
              'complaint_id, user_id, complaint_type, channel, event_type, description, timestamp, resolved',
            ],
            [
              'data/dnd_violations.csv',
              '12,847',
              'violation_id, user_id, phone, notification_id, event_type, channel, dnd_category, message_classification, detected_at, root_cause, provider, resolved, resolution',
            ],
            [
              'data/delivery_performance.csv',
              '540',
              'date, channel, provider, total_sent, total_delivered, total_failed, delivery_rate, p50/p95/p99_latency_ms, cost_inr, circuit_opens, avg_retry_count',
            ],
          ],
          [2600, 1200, 5560],
        ),
        body(
          'All datasets generated by scripts/generate-datasets.ts with realistic distributions per spec Section B4.1 (40% transaction, 20% risk, 15% SIP, 15% market, 10% regulatory; 80% during market hours 09:15\u201315:30 IST).',
        ),

        pageBreak(),

        // ─── SECTION 14: SUBMISSION CHECKLIST ────────────────────────────
        h1('14. Submission Checklist'),
        h2('14.1 Core Requirements'),
        makeTable(
          ['Requirement', 'Status', 'Evidence'],
          [
            [
              '25+ financial event types',
              '\u2705 Complete',
              'docs/event-taxonomy.yaml, all 25 in template engine',
            ],
            [
              'SMS, Email, Push, WhatsApp, In-App delivery',
              '\u2705 Complete',
              'src/delivery/providers/ (5 providers)',
            ],
            [
              'User preference management',
              '\u2705 Complete',
              'GET/PUT /api/v1/users/:id/preferences, 4-layer hierarchy',
            ],
            [
              'TRAI DND compliance',
              '\u2705 Complete',
              'DND at dispatch, TRANSACTIONAL/PROMOTIONAL classification',
            ],
            [
              'Delivery tracking & state machine',
              '\u2705 Complete',
              '15 states, all transitions logged to notification_state_log',
            ],
            [
              'Dead Letter Queue with retry strategy',
              '\u2705 Complete',
              'Exponential backoff, priority configs, DLQ management API',
            ],
            [
              'Template engine with personalisation & localisation',
              '\u2705 Complete',
              'Handlebars, 25 templates, 5 languages',
            ],
            [
              'Frequency capping',
              '\u2705 Complete',
              'Multi-dimensional: global/channel/category/cooldown',
            ],
            [
              'Quiet hours enforcement',
              '\u2705 Complete',
              'IANA timezone, CRITICAL bypass, morning digest',
            ],
            [
              'Real-time analytics pipeline',
              '\u2705 Complete',
              '9 Prometheus metrics, 3 analytics API endpoints',
            ],
            [
              'Repository transferred to @ZethetaIntern',
              '\u2705 Complete',
              'GitHub transfer completed on Day 15',
            ],
          ],
          [3600, 1200, 4560],
        ),
        spacer(),
        h2('14.2 Bonus Features (Section B3.4)'),
        makeTable(
          ['Bonus Feature', 'Points', 'Status'],
          [
            [
              'A/B testing with statistical significance (two-proportion z-test)',
              '25',
              '\u2705 Complete',
            ],
            [
              'Notification preview API (POST /api/v1/notifications/preview)',
              '25',
              '\u2705 Complete',
            ],
            [
              'Send-time optimisation (per-user engagement scoring with decay)',
              '25',
              '\u2705 Complete',
            ],
            [
              'Real-time WebSocket dashboard (Socket.io)',
              '25',
              '\u2705 Complete',
            ],
            [
              'Document Error Log (5 deliberate errors found and documented)',
              'Bonus',
              '\u2705 Complete',
            ],
          ],
          [4200, 1200, 3960],
        ),
        spacer(),
        h2('14.3 Repository Structure'),
        makeTable(
          ['Required Path', 'Present'],
          [
            ['.github/workflows/ci.yml', '\u2705'],
            ['docs/architecture.md', '\u2705'],
            ['docs/api-specification.yaml', '\u2705'],
            ['docs/event-taxonomy.yaml', '\u2705'],
            ['docs/database-schema.md', '\u2705'],
            ['docs/sequence-diagrams/ (3 diagrams)', '\u2705'],
            ['docs/performance-benchmarks.md', '\u2705'],
            ['docs/postman-collection.json', '\u2705'],
            ['src/database/migrations', '\u2705'],
            ['tests/unit/ + tests/load/', '\u2705'],
            ['docker-compose.yml + Dockerfile', '\u2705'],
            ['.env.example + .zetheta-project.json', '\u2705'],
            [
              'README.md + ARCHITECTURE.md + CHANGELOG.md + DEPLOYMENT.md',
              '\u2705',
            ],
          ],
          [6500, 2860],
        ),

        pageBreak(),

        // ─── CLOSING ──────────────────────────────────────────────────────
        h1('15. Closing Statement'),
        body(
          'This submission represents a production-grade implementation of the WealthBridge Notification Engine specification. Every core requirement from the 74-page assessment document has been implemented, tested, and verified.',
        ),
        spacer(),
        body(
          'The implementation demonstrates several engineering judgement calls beyond the spec:',
        ),
        bullet(
          'Statistical significance calculation added to A/B testing (spec asked for it but did not specify the algorithm; two-proportion z-test at 95% confidence was chosen)',
        ),
        bullet(
          'DND check positioned at last moment before dispatch (spec mentions this best practice in Case Study C3 but does not explicitly require it in Section A6)',
        ),
        bullet(
          'Five specification errors identified and corrected in the implementation rather than blindly implemented (documented in Section 12)',
        ),
        bullet(
          "Webhook DLR controllers added to close the missing DELIVERED state transition path (spec's Appendix B sequence diagram shows DLR webhook but Section D never explicitly requires the endpoint)",
        ),
        spacer(),
        body(
          'GitHub Repository: https://github.com/ZethetaIntern/BE-6B-NotificationEngine-UkashatuAbdullahi',
        ),
        body('Intern ID: 493556B'),
        body('Submission Date: 22 June 2026'),
      ],
    },
  ],
});

Packer.toBuffer(doc)
  .then((buffer) => {
    fs.writeFileSync(
      'mnt/user-data/outputs/493556B_UkashatuAbdullahi_MainReport.docx',
      buffer,
    );
    console.log('Written successfully');
  })
  .catch((e) => console.error(e));
