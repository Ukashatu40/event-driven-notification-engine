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
} = require('docx');
const fs = require('fs');

const ACCENT = '1F4E79';
const ACCENT2 = '2E75B6';
const LIGHT_BLUE = 'D6E4F0';
const WHITE = 'FFFFFF';
const LIGHT_GRAY = 'F2F2F2';

const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 100, bottom: 100, left: 150, right: 150 };

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 180 },
    children: [
      new TextRun({ text, bold: true, size: 30, color: ACCENT, font: 'Arial' }),
    ],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 4, color: ACCENT2, space: 4 },
    },
    children: [
      new TextRun({
        text,
        bold: true,
        size: 24,
        color: ACCENT2,
        font: 'Arial',
      }),
    ],
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text, size: 20, font: 'Arial', ...opts })],
  });
}

function speaker(text) {
  return new Paragraph({
    spacing: { before: 120, after: 60 },
    indent: { left: 0 },
    children: [
      new TextRun({
        text,
        size: 22,
        font: 'Arial',
        bold: false,
        italics: false,
      }),
    ],
  });
}

function label(text) {
  return new Paragraph({
    spacing: { before: 160, after: 40 },
    children: [
      new TextRun({
        text,
        size: 20,
        font: 'Arial',
        bold: true,
        color: ACCENT2,
      }),
    ],
  });
}

function timing(text) {
  return new Paragraph({
    spacing: { before: 0, after: 80 },
    children: [
      new TextRun({
        text: `[${text}]`,
        size: 18,
        font: 'Arial',
        color: '888888',
        italics: true,
      }),
    ],
  });
}

function note(text) {
  return new Paragraph({
    spacing: { before: 40, after: 40 },
    indent: { left: 360 },
    children: [
      new TextRun({
        text: `\u2139\uFE0F  ${text}`,
        size: 18,
        font: 'Arial',
        color: '666666',
        italics: true,
      }),
    ],
  });
}

function spacer() {
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    children: [new TextRun('')],
  });
}

function divider() {
  return new Paragraph({
    spacing: { before: 160, after: 160 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD', space: 1 },
    },
    children: [new TextRun('')],
  });
}

function timelineRow(time, section, topic) {
  return new TableRow({
    children: [
      new TableCell({
        borders,
        margins: cellMargins,
        width: { size: 1400, type: WidthType.DXA },
        shading: { fill: ACCENT2, type: ShadingType.CLEAR },
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: time,
                bold: true,
                size: 18,
                color: WHITE,
                font: 'Arial',
              }),
            ],
          }),
        ],
      }),
      new TableCell({
        borders,
        margins: cellMargins,
        width: { size: 2400, type: WidthType.DXA },
        shading: { fill: LIGHT_BLUE, type: ShadingType.CLEAR },
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: section,
                bold: true,
                size: 18,
                color: ACCENT,
                font: 'Arial',
              }),
            ],
          }),
        ],
      }),
      new TableCell({
        borders,
        margins: cellMargins,
        width: { size: 5560, type: WidthType.DXA },
        shading: { fill: WHITE, type: ShadingType.CLEAR },
        children: [
          new Paragraph({
            children: [new TextRun({ text: topic, size: 18, font: 'Arial' })],
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
        run: { size: 30, bold: true, font: 'Arial', color: ACCENT },
        paragraph: { spacing: { before: 320, after: 180 }, outlineLevel: 0 },
      },
      {
        id: 'Heading2',
        name: 'Heading 2',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 24, bold: true, font: 'Arial', color: ACCENT2 },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 },
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
        // ─── COVER ────────────────────────────────────────────────────────
        new Paragraph({
          spacing: { before: 720, after: 120 },
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: 'ZETHETA ALGORITHMS \u2014 BE-6B Submission',
              size: 18,
              color: '888888',
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          spacing: { before: 0, after: 480 },
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: 'Intern ID: 493556B \u2014 Ukashatu Abdullahi',
              size: 18,
              color: '888888',
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          spacing: { before: 0, after: 120 },
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: 'FEEDBACK VIDEO SCRIPT',
              size: 44,
              bold: true,
              color: ACCENT,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          spacing: { before: 0, after: 600 },
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: 'Event-Driven Notification Engine \u2014 Project BE-6B',
              size: 26,
              color: ACCENT2,
              font: 'Arial',
            }),
          ],
        }),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [2400, 6960],
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  borders,
                  margins: cellMargins,
                  width: { size: 2400, type: WidthType.DXA },
                  shading: { fill: LIGHT_BLUE, type: ShadingType.CLEAR },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: 'Duration',
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
                  width: { size: 6960, type: WidthType.DXA },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: '3\u20134 minutes (target). Maximum 5 minutes.',
                          size: 18,
                          font: 'Arial',
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
            new TableRow({
              children: [
                new TableCell({
                  borders,
                  margins: cellMargins,
                  width: { size: 2400, type: WidthType.DXA },
                  shading: { fill: LIGHT_BLUE, type: ShadingType.CLEAR },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: 'Format',
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
                  width: { size: 6960, type: WidthType.DXA },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: 'Face clearly visible. Speak directly to camera. Well-lit background.',
                          size: 18,
                          font: 'Arial',
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
            new TableRow({
              children: [
                new TableCell({
                  borders,
                  margins: cellMargins,
                  width: { size: 2400, type: WidthType.DXA },
                  shading: { fill: LIGHT_BLUE, type: ShadingType.CLEAR },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: 'Purpose',
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
                  width: { size: 6960, type: WidthType.DXA },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: 'Demonstrate understanding of what you built. Boost shortlisting chances. Show communication skill.',
                          size: 18,
                          font: 'Arial',
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
        spacer(),
        body(
          'This document contains the full word-for-word script, a production timeline, camera direction notes, and a preparation checklist. Read through all sections before recording.',
        ),

        divider(),

        // ─── TIMELINE ─────────────────────────────────────────────────────
        h1('Video Timeline'),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [1400, 2400, 5560],
          rows: [
            new TableRow({
              tableHeader: true,
              children: [
                new TableCell({
                  borders,
                  margins: cellMargins,
                  width: { size: 1400, type: WidthType.DXA },
                  shading: { fill: ACCENT, type: ShadingType.CLEAR },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: 'Timestamp',
                          bold: true,
                          size: 18,
                          color: WHITE,
                          font: 'Arial',
                        }),
                      ],
                    }),
                  ],
                }),
                new TableCell({
                  borders,
                  margins: cellMargins,
                  width: { size: 2400, type: WidthType.DXA },
                  shading: { fill: ACCENT, type: ShadingType.CLEAR },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: 'Section',
                          bold: true,
                          size: 18,
                          color: WHITE,
                          font: 'Arial',
                        }),
                      ],
                    }),
                  ],
                }),
                new TableCell({
                  borders,
                  margins: cellMargins,
                  width: { size: 5560, type: WidthType.DXA },
                  shading: { fill: ACCENT, type: ShadingType.CLEAR },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: 'Content',
                          bold: true,
                          size: 18,
                          color: WHITE,
                          font: 'Arial',
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
            timelineRow(
              '0:00 \u2013 0:20',
              'Introduction',
              'Name, intern ID, project name',
            ),
            timelineRow(
              '0:20 \u2013 0:50',
              'Business Problem',
              'What WealthBridge was suffering and why it mattered',
            ),
            timelineRow(
              '0:50 \u2013 1:30',
              'Architecture',
              'Kafka \u2192 Engine \u2192 RabbitMQ \u2192 Providers pipeline',
            ),
            timelineRow(
              '1:30 \u2013 2:10',
              'Key Features',
              'DND compliance, frequency capping, circuit breaker',
            ),
            timelineRow(
              '2:10 \u2013 2:40',
              'Results',
              '545 req/s, P99 10.9ms, 124 tests passing',
            ),
            timelineRow(
              '2:40 \u2013 3:10',
              'Bonus Features',
              'All 4 bonus features with statistical significance',
            ),
            timelineRow(
              '3:10 \u2013 3:40',
              'What I Learned',
              'Distributed systems, regulatory compliance, resilience',
            ),
            timelineRow('3:40 \u2013 4:00', 'Close', 'GitHub link, thank you'),
          ],
        }),

        divider(),

        // ─── FULL SCRIPT ──────────────────────────────────────────────────
        h1('Full Script'),
        note(
          'Read this aloud 2\u20133 times before recording. Speak at a natural pace \u2014 do not rush. Pauses are better than filler words.',
        ),
        spacer(),

        // SECTION 1: INTRO
        label('SECTION 1 \u2014 INTRODUCTION (0:00 \u2013 0:20)'),
        timing('Look directly at camera. Smile naturally. Speak clearly.'),
        spacer(),

        speaker('Hi, my name is Ukashatu Abdullahi, intern ID 493556B.'),
        spacer(),
        speaker(
          'Over the past 15 days I built the BE-6B Event-Driven Notification Engine \u2014 a production-grade backend system for a financial services platform called WealthBridge.',
        ),
        spacer(),
        speaker(
          "I'm going to walk you through what I built, why the design decisions matter, and what I learned.",
        ),

        divider(),

        // SECTION 2: PROBLEM
        label('SECTION 2 \u2014 THE BUSINESS PROBLEM (0:20 \u2013 0:50)'),
        timing("Lean slightly forward. This is the 'why it matters' part."),
        spacer(),

        speaker(
          'WealthBridge was in crisis. The system was sending 2.1 million notifications every day, but it was doing it badly.',
        ),
        spacer(),
        speaker(
          '23% of users had opted out \u2014 nearly three times the industry average.',
        ),
        spacer(),
        speaker(
          '18.7% of margin calls \u2014 which are legally mandatory notifications under SEBI \u2014 were arriving after the auto-square-off deadline. That cost customers 4.7 crore rupees in losses last quarter.',
        ),
        spacer(),
        speaker(
          'And TRAI had issued a show-cause notice for over 12,000 DND violations, with a potential fine of 50 lakh per violation.',
        ),
        spacer(),
        speaker(
          'The root causes were: no channel intelligence, no regulatory compliance at the dispatch layer, and a monolithic architecture that crashed under market volatility.',
        ),
        spacer(),
        speaker('My job was to build a replacement from scratch in 15 days.'),

        divider(),

        // SECTION 3: ARCHITECTURE
        label('SECTION 3 \u2014 ARCHITECTURE (0:50 \u2013 1:30)'),
        timing('You can gesture with your hands here to describe the flow.'),
        spacer(),

        speaker(
          'The system is built on an event-driven architecture with three distinct layers.',
        ),
        spacer(),
        speaker(
          "First, the ingestion layer. Every financial event \u2014 a buy order, a margin call, a price alert \u2014 enters through a REST API and is published to Apache Kafka. Critical events like margin calls go to a dedicated Kafka topic with a dedicated consumer group so they're never queued behind low-priority notifications.",
        ),
        spacer(),
        speaker(
          "Second, the processing layer. Each event goes through a pipeline: deduplication check using Redis fingerprinting, DND compliance check, frequency cap evaluation, quiet hours enforcement, then template rendering in the user's preferred language \u2014 Hindi, Marathi, Tamil, Telugu, or English.",
        ),
        spacer(),
        speaker(
          'Third, the delivery layer. Rendered notifications are published to RabbitMQ priority queues and dispatched by delivery workers to the appropriate channel \u2014 SMS via MSG91 or Twilio, email via Nodemailer, push via FCM, WhatsApp via the Cloud API, and in-app via WebSocket.',
        ),
        spacer(),
        speaker(
          'Everything is observable: 9 Prometheus metrics, structured JSON logging with correlation IDs that follow every notification from Kafka ingestion to delivery confirmation, and health check endpoints for container orchestration.',
        ),

        divider(),

        // SECTION 4: KEY FEATURES
        label('SECTION 4 \u2014 KEY FEATURES (1:30 \u2013 2:10)'),
        timing(
          'Pick the 3 features you feel most confident explaining. These three are the strongest.',
        ),
        spacer(),

        speaker(
          "Let me highlight three design decisions I'm particularly proud of.",
        ),
        spacer(),
        speaker(
          "First, DND compliance. The spec required checking TRAI's Do Not Disturb registry, but the key insight is WHERE in the pipeline you check it. I check DND at the absolute last moment before SMS dispatch \u2014 not during routing. This prevents race conditions where a user registers for DND after the routing decision is made but before the SMS is sent. That's the exact mistake that caused real-world violations in the Paytm Money case study.",
        ),
        spacer(),
        speaker(
          'Second, multi-dimensional frequency capping. The system enforces five overlapping caps simultaneously \u2014 a global daily limit, per-channel limits, per-category hourly limits, and a 15-minute cooldown between the same event type. And critically, CRITICAL events bypass all of these. A margin call will always get through, even if the user has hit their daily cap.',
        ),
        spacer(),
        speaker(
          "Third, the circuit breaker. If MSG91 fails five times in 60 seconds, the circuit opens, all SMS traffic automatically reroutes to Twilio as a secondary provider, and the ops team is alerted. When MSG91 recovers, the circuit half-opens, sends a probe request, and closes again \u2014 with idempotency keys ensuring messages sent during failover aren't re-sent.",
        ),

        divider(),

        // SECTION 5: RESULTS
        label('SECTION 5 \u2014 PERFORMANCE RESULTS (2:10 \u2013 2:40)'),
        timing(
          'Be specific with numbers. This shows you understand your own system.',
        ),
        spacer(),

        speaker('I ran three k6 load test scenarios.'),
        spacer(),
        speaker(
          'In the market crash scenario \u2014 simulating 450,000 notifications in 30 minutes \u2014 the system achieved 545 requests per second with a P99 latency of 10.9 milliseconds for margin calls. The SEBI SLA requirement is 10 seconds. My system is 921 times faster than that requirement.',
        ),
        spacer(),
        speaker(
          'In the multi-language emergency broadcast scenario \u2014 4.2 million users in 4 hours \u2014 the P95 latency was 3.76 milliseconds. The required throughput is 292 notifications per second. A single instance handles 545 per second, so no horizontal scaling is needed for that scenario.',
        ),
        spacer(),
        speaker(
          'The test suite has 124 unit tests across 12 test suites, all passing. And the CI pipeline runs lint, tests, coverage report, npm audit, and a secrets scanner on every push.',
        ),

        divider(),

        // SECTION 6: BONUS FEATURES
        label('SECTION 6 \u2014 BONUS FEATURES (2:40 \u2013 3:10)'),
        timing(
          'All 4 bonuses. Keep it concise \u2014 one sentence each, then elaborate on the most interesting one.',
        ),
        spacer(),

        speaker('I implemented all four bonus features from Section B3.4.'),
        spacer(),
        speaker(
          'A/B testing with statistical significance \u2014 using a two-proportion z-test at 95% confidence. It tracks delivery rates and read rates per template variant and tells you whether the difference is statistically significant or just noise.',
        ),
        spacer(),
        speaker(
          "A notification preview API that lets users see exactly what they'll receive on each channel before opting in \u2014 which directly addresses the opt-out problem.",
        ),
        spacer(),
        speaker(
          "Send-time optimisation \u2014 the system scores each user's historical engagement by hour of day with exponential decay, and delays non-urgent notifications to the hour when that specific user is most likely to open them. It requires 10 samples minimum before activating, so it never degrades the experience for new users.",
        ),
        spacer(),
        speaker(
          'And a real-time WebSocket dashboard built with Socket.io that broadcasts live notification metrics to authenticated clients.',
        ),
        spacer(),
        speaker(
          'I also found and documented all five deliberate errors in the specification \u2014 including an off-by-one error in the retry backoff formula and a mathematically inconsistent frequency cap configuration.',
        ),

        divider(),

        // SECTION 7: LEARNINGS
        label('SECTION 7 \u2014 WHAT I LEARNED (3:10 \u2013 3:40)'),
        timing(
          'Be genuine here. Speak from your actual experience building this.',
        ),
        spacer(),

        speaker(
          "This project taught me things I couldn't have learned from a textbook.",
        ),
        spacer(),
        speaker(
          "On the technical side: the difference between checking DND at routing time versus dispatch time seems like a minor detail, but it's the difference between compliance and a regulatory fine. Distributed systems care deeply about the ORDER of operations.",
        ),
        spacer(),
        speaker(
          "I also learned that Prisma doesn't generate its client types until you run prisma generate against a live database \u2014 which means your TypeScript types are wrong until that happens. I had to work around this in tests by mocking the service before import.",
        ),
        spacer(),
        speaker(
          'On the process side: having 74 pages of specification is actually an advantage if you read it carefully. I found five errors in it by reading section A9 and A5 carefully and thinking through the consequences. That kind of critical reading is as important as coding.',
        ),
        spacer(),
        speaker(
          "And building something you genuinely care about getting right \u2014 a system where a bug means someone's margin call doesn't arrive in time \u2014 makes you think more carefully about every design decision.",
        ),

        divider(),

        // SECTION 8: CLOSE
        label('SECTION 8 \u2014 CLOSING (3:40 \u2013 4:00)'),
        timing(
          'Sit up straight. Direct eye contact. Confident but not rushed.',
        ),
        spacer(),

        speaker(
          'The complete source code, documentation, datasets, and all 15 days of deliverables are in the GitHub repository at github.com/Ukashatu40/BE-6B-NotificationEngine-UkashatuAbdullahi.',
        ),
        spacer(),
        speaker(
          "Thank you for reviewing my submission. I genuinely enjoyed building this system and I'm looking forward to the assessment feedback.",
        ),

        divider(),

        // ─── PRODUCTION NOTES ─────────────────────────────────────────────
        h1('Recording Preparation Checklist'),
        spacer(),

        h2('Before Recording'),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'Read the full script aloud 3 times. Time yourself \u2014 target 3:30 to 3:50.',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'Find a quiet room with good natural light falling on your face (not behind you).',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'Camera at eye level, not looking up or down. Phone propped up or laptop webcam works.',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'Wear a plain, neat top. Avoid busy patterns that distract on video.',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'Print or have the script visible just below camera level so your eyes stay near the lens.',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'Do a 10-second test recording and watch it back to check audio, lighting, and framing.',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        spacer(),

        h2('During Recording'),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: "Speak to the camera lens, not the screen. Imagine you're talking to a senior engineer at Zetheta.",
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: "If you stumble, pause and restart that sentence. Do not say 'um' or 'uh' \u2014 silence is better.",
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'Speak slightly slower than feels natural. Nerves make people rush.',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: "Gestures are fine and natural. Don't hold yourself artificially still.",
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'Record 2\u20133 takes. Use the one where you sound most natural, not necessarily the most perfect.',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        spacer(),

        h2('Key Points to Land (Know These Cold)'),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'The business problem in numbers: 23% opt-out, 18.7% late margin calls, 12,847 DND violations',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'The three-layer architecture: Kafka ingestion \u2192 processing engine \u2192 RabbitMQ + delivery workers',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'DND check at dispatch, not routing \u2014 and why this matters',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: '545 req/s, P99 10.9ms for margin calls, 921\u00D7 faster than SEBI SLA',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'All 4 bonus features + 5 spec errors found',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: '124 tests passing, 12/12 suites green',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        spacer(),

        h2('What NOT to Do'),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'Do not read directly from the script word-for-word in a robotic way. Know it well enough to speak naturally.',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: "Do not apologise or say 'I'm not sure if this is right.' Speak with confidence about what you built.",
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'Do not go over 5 minutes. Evaluators watch dozens of these. Respect their time.',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),
        new Paragraph({
          numbering: { reference: 'bullets', level: 0 },
          spacing: { before: 40, after: 40 },
          children: [
            new TextRun({
              text: 'Do not have your phone lighting up or notification sounds going off in the background.',
              size: 20,
              font: 'Arial',
            }),
          ],
        }),

        divider(),

        h1('Quick Reference Card'),
        body(
          'Memorise these numbers before recording. If you know them cold, your delivery will sound confident.',
        ),
        spacer(),
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [3800, 5560],
          rows: [
            new TableRow({
              tableHeader: true,
              children: [
                new TableCell({
                  borders,
                  margins: cellMargins,
                  width: { size: 3800, type: WidthType.DXA },
                  shading: { fill: ACCENT2, type: ShadingType.CLEAR },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: 'Fact',
                          bold: true,
                          size: 18,
                          color: WHITE,
                          font: 'Arial',
                        }),
                      ],
                    }),
                  ],
                }),
                new TableCell({
                  borders,
                  margins: cellMargins,
                  width: { size: 5560, type: WidthType.DXA },
                  shading: { fill: ACCENT2, type: ShadingType.CLEAR },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: 'Number / Detail',
                          bold: true,
                          size: 18,
                          color: WHITE,
                          font: 'Arial',
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
            ...[
              [
                'Event types supported',
                '25 across 5 categories (TXNX, RISK, SIPX, MKTX, REGX)',
              ],
              ['Delivery channels', '5: SMS, Email, Push, WhatsApp, In-App'],
              ['SMS providers', 'MSG91 (primary) + Twilio (failover)'],
              [
                'Languages supported',
                '5: English, Hindi, Marathi, Tamil, Telugu',
              ],
              ['Daily notification cap (global)', '12 per user (rolling 24h)'],
              [
                'CRITICAL event latency P99',
                '10.9ms (vs 10,000ms SEBI SLA = 921\u00D7 faster)',
              ],
              [
                'Throughput under market crash',
                '545 requests/second, 0% failures',
              ],
              ['Test suite', '124 tests, 12 suites, 100% passing'],
              ['Prometheus metrics', '9 metrics per spec Section A11.1'],
              [
                'Datasets generated',
                '100K events, 10K users, 12,847 DND violations',
              ],
              [
                'Bonus features completed',
                '4/4 (A/B test, preview, STO, WebSocket)',
              ],
              [
                'Spec errors identified',
                '5 deliberate errors found and documented',
              ],
              ['DLQ retry: CRITICAL', '10 retries, 500ms base, 60s max'],
              ['Circuit breaker threshold', '5 failures in 60 seconds'],
              [
                'GitHub repo',
                'https://github.com/ZethetaIntern/BE-6B-NotificationEngine-UkashatuAbdullahi',
              ],
            ].map(
              (r, i) =>
                new TableRow({
                  children: [
                    new TableCell({
                      borders,
                      margins: cellMargins,
                      width: { size: 3800, type: WidthType.DXA },
                      shading: {
                        fill: i % 2 === 0 ? 'F2F2F2' : WHITE,
                        type: ShadingType.CLEAR,
                      },
                      children: [
                        new Paragraph({
                          children: [
                            new TextRun({
                              text: r[0],
                              bold: true,
                              size: 18,
                              font: 'Arial',
                            }),
                          ],
                        }),
                      ],
                    }),
                    new TableCell({
                      borders,
                      margins: cellMargins,
                      width: { size: 5560, type: WidthType.DXA },
                      shading: {
                        fill: i % 2 === 0 ? 'F2F2F2' : WHITE,
                        type: ShadingType.CLEAR,
                      },
                      children: [
                        new Paragraph({
                          children: [
                            new TextRun({
                              text: r[1],
                              size: 18,
                              font: 'Arial',
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
            ),
          ],
        }),
      ],
    },
  ],
});

Packer.toBuffer(doc)
  .then((buffer) => {
    fs.writeFileSync(
      'mnt/user-data/outputs/493556B_UkashatuAbdullahi_FeedbackVideoScript.docx',
      buffer,
    );
    console.log('Done');
  })
  .catch((e) => console.error(e));
