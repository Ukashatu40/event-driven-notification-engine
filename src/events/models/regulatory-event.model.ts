// src/events/models/regulatory-event.model.ts
import { BaseEvent } from './base-event.model';

export interface RegulatoryPayload {
  expiry_date?: string;
  documents_needed?: string;
  change_summary?: string;
  impact?: string;
  effective_date?: string;
}

export interface RegulatoryEvent extends BaseEvent {
  eventType: 'REGX-001' | 'REGX-002' | 'REGX-003' | 'REGX-004' | 'REGX-005';
  payload: RegulatoryPayload;
}
