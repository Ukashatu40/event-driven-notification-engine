// src/events/models/risk-event.model.ts
import { BaseEvent } from './base-event.model';

export interface MarginCallPayload {
  shortfall_amount: number;
  current_margin: number;
  required_margin: number;
  deadline: string;
  auto_square_off_time: string;
  affected_positions?: Array<{
    symbol: string;
    qty: number;
    current_value: number;
  }>;
}

export interface RiskEvent extends BaseEvent {
  eventType: 'RISK-001' | 'RISK-002' | 'RISK-003' | 'RISK-004' | 'RISK-005';
  payload: MarginCallPayload;
}
