// src/delivery/providers/delivery-provider.interface.ts
export interface DeliveryResult {
  success: boolean;
  externalId?: string;
  provider: string;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
  rawResponse?: unknown;
}

export interface DeliveryStatus {
  externalId: string;
  status: 'delivered' | 'failed' | 'pending' | 'bounced';
  updatedAt: string;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface QuotaInfo {
  remaining: number;
  resetAt: string;
}

export interface PreparedNotification {
  notificationId: string;
  userId: string;
  channel: string;
  recipient: string; // phone / email / deviceToken / userId
  subject?: string;
  title?: string;
  body: string;
  data?: Record<string, unknown>;
  priority: number;
  correlationId: string;
}

/**
 * Unified interface all delivery providers must implement.
 * Abstraction ensures the routing engine never knows which
 * specific provider is sending — enabling seamless failover.
 */
export interface IDeliveryProvider {
  readonly providerName: string;
  readonly channel: string;

  send(notification: PreparedNotification): Promise<DeliveryResult>;
  getStatus(externalId: string): Promise<DeliveryStatus>;
  validateRecipient(address: string): Promise<ValidationResult>;
  getQuota(): Promise<QuotaInfo>;
  healthCheck(): Promise<boolean>;
}
