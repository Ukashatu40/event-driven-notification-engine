// src/events/models/base-event.model.ts
export interface BaseEvent {
  eventType: string;
  eventId: string;
  sourceSystem: string;
  timestamp: string;
  priority: 1 | 2 | 3 | 5;
  userId: string;
  payload: Record<string, any>;
  idempotencyKey?: string;
}
