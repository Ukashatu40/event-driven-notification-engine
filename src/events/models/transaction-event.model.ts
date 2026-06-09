// src/events/models/transaction-event.model.ts
import { BaseEvent } from './base-event.model';

export interface OrderExecutedPayload {
  stock_name: string;
  symbol: string;
  qty: number;
  price: number;
  total: number;
  order_id: string;
  portfolio_value?: number;
}

export interface TransactionEvent extends BaseEvent {
  eventType: 'TXNX-001' | 'TXNX-002' | 'TXNX-003' | 'TXNX-004' | 'TXNX-005';
  payload: OrderExecutedPayload;
}
