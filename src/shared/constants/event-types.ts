export const EVENT_TYPES = {
  // Transaction events
  TXNX_001: 'TXNX-001', // Buy Order Executed
  TXNX_002: 'TXNX-002', // Sell Order Executed
  TXNX_003: 'TXNX-003', // Order Rejected
  TXNX_004: 'TXNX-004', // Dividend Credited
  TXNX_005: 'TXNX-005', // Funds Deposited

  // Risk & Margin events
  RISK_001: 'RISK-001', // Margin Call Warning — CRITICAL
  RISK_002: 'RISK-002', // Margin Shortfall — CRITICAL
  RISK_003: 'RISK-003', // Position Squared Off — CRITICAL
  RISK_004: 'RISK-004', // Portfolio Risk Alert
  RISK_005: 'RISK-005', // Concentration Alert

  // SIP & Investment events
  SIPX_001: 'SIPX-001', // SIP Due Reminder
  SIPX_002: 'SIPX-002', // SIP Executed
  SIPX_003: 'SIPX-003', // SIP Failed
  SIPX_004: 'SIPX-004', // SIP Step-Up Reminder
  SIPX_005: 'SIPX-005', // Goal Milestone Reached

  // Market & Price events
  MKTX_001: 'MKTX-001', // Price Alert Triggered
  MKTX_002: 'MKTX-002', // Circuit Breaker Hit — CRITICAL
  MKTX_003: 'MKTX-003', // Market Open/Close
  MKTX_004: 'MKTX-004', // 52-Week High/Low
  MKTX_005: 'MKTX-005', // Earnings Announcement

  // Regulatory & Compliance events
  REGX_001: 'REGX-001', // KYC Expiry Warning
  REGX_002: 'REGX-002', // Nominee Update Reminder
  REGX_003: 'REGX-003', // Contract Note Generated
  REGX_004: 'REGX-004', // Tax Statement Available
  REGX_005: 'REGX-005', // Regulatory Policy Change
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

// Events that are SEBI/AMFI/Banking regulatory mandatory
export const REGULATORY_MANDATORY_EVENTS: EventType[] = [
  EVENT_TYPES.TXNX_001,
  EVENT_TYPES.TXNX_002,
  EVENT_TYPES.TXNX_003,
  EVENT_TYPES.TXNX_005,
  EVENT_TYPES.RISK_001,
  EVENT_TYPES.RISK_002,
  EVENT_TYPES.RISK_003,
  EVENT_TYPES.SIPX_002,
  EVENT_TYPES.SIPX_003,
  EVENT_TYPES.MKTX_002,
  EVENT_TYPES.REGX_001,
  EVENT_TYPES.REGX_003,
];

// Events that bypass ALL user preferences, DND (promotional), frequency caps
export const CRITICAL_EVENTS: EventType[] = [
  EVENT_TYPES.RISK_001,
  EVENT_TYPES.RISK_002,
  EVENT_TYPES.RISK_003,
  EVENT_TYPES.MKTX_002,
];

// Classification for DND purposes
export const TRANSACTIONAL_EVENTS: EventType[] = [
  EVENT_TYPES.TXNX_001,
  EVENT_TYPES.TXNX_002,
  EVENT_TYPES.TXNX_003,
  EVENT_TYPES.TXNX_004,
  EVENT_TYPES.TXNX_005,
  EVENT_TYPES.RISK_001,
  EVENT_TYPES.RISK_002,
  EVENT_TYPES.RISK_003,
  EVENT_TYPES.SIPX_002,
  EVENT_TYPES.SIPX_003,
  EVENT_TYPES.MKTX_002,
  EVENT_TYPES.REGX_001,
  EVENT_TYPES.REGX_003,
];
// Everything NOT in TRANSACTIONAL_EVENTS is PROMOTIONAL
