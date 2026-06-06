// src/compliance/dnd/dnd-classifier.service.ts
import { Injectable } from '@nestjs/common';
import {
  EventType,
  TRANSACTIONAL_EVENTS,
} from '../../shared/constants/event-types';

export type MessageClassification = 'TRANSACTIONAL' | 'PROMOTIONAL';

/**
 * Classifies every notification as TRANSACTIONAL or PROMOTIONAL.
 *
 * This is the most critical compliance decision in the system.
 * Misclassifying a PROMOTIONAL message as TRANSACTIONAL to bypass DND
 * is the primary cause of TRAI fines (see Case Study C3 — ₹20 crore fine wave).
 *
 * TRANSACTIONAL: order confirmations, OTPs, margin calls, account alerts.
 *   → Exempt from DND for registered users.
 * PROMOTIONAL: SIP step-up suggestions, new fund recommendations, market insights.
 *   → MUST respect DND. Blocked for DND-registered users.
 */
@Injectable()
export class DndClassifierService {
  classify(eventType: EventType): MessageClassification {
    return TRANSACTIONAL_EVENTS.includes(eventType)
      ? 'TRANSACTIONAL'
      : 'PROMOTIONAL';
  }

  isTransactional(eventType: EventType): boolean {
    return this.classify(eventType) === 'TRANSACTIONAL';
  }

  isPromotional(eventType: EventType): boolean {
    return this.classify(eventType) === 'PROMOTIONAL';
  }
}
