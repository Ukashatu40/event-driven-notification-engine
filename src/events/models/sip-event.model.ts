// src/events/models/sip-event.model.ts
import { BaseEvent } from './base-event.model';

export interface SipPayload {
  fund_name: string;
  amount: number;
  sip_date: string;
  units_allotted?: number;
  nav?: number;
  reason?: string;
}

export interface SipEvent extends BaseEvent {
  eventType: 'SIPX-001' | 'SIPX-002' | 'SIPX-003' | 'SIPX-004' | 'SIPX-005';
  payload: SipPayload;
}
