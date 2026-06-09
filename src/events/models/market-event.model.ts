// src/events/models/market-event.model.ts
import { BaseEvent } from './base-event.model';

export interface PriceAlertPayload {
  symbol: string;
  stock_name: string;
  target_price: number;
  current_price: number;
  direction: 'ABOVE' | 'BELOW';
}

export interface MarketEvent extends BaseEvent {
  eventType: 'MKTX-001' | 'MKTX-002' | 'MKTX-003' | 'MKTX-004' | 'MKTX-005';
  payload: PriceAlertPayload;
}
