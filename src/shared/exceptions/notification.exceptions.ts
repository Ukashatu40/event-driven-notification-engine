// src/shared/exceptions/notification.exceptions.ts

import { HttpException, HttpStatus } from '@nestjs/common';

export class NotificationNotFoundException extends HttpException {
  constructor(notificationId: string) {
    super(
      {
        error: 'NOTIFICATION_NOT_FOUND',
        message: `Notification ${notificationId} not found`,
        notificationId,
      },
      HttpStatus.NOT_FOUND,
    );
  }
}

export class InvalidEventTypeException extends HttpException {
  constructor(eventType: string) {
    super(
      {
        error: 'INVALID_EVENT_TYPE',
        message: `Event type '${eventType}' is not recognized`,
        eventType,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class DuplicateEventException extends HttpException {
  constructor(idempotencyKey: string) {
    super(
      {
        error: 'DUPLICATE_EVENT',
        message: 'This event has already been processed',
        idempotencyKey,
      },
      HttpStatus.CONFLICT,
    );
  }
}

export class InvalidStateTransitionException extends HttpException {
  constructor(from: string, to: string, notificationId: string) {
    super(
      {
        error: 'INVALID_STATE_TRANSITION',
        message: `Cannot transition notification from ${from} to ${to}`,
        from,
        to,
        notificationId,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ProviderUnavailableException extends HttpException {
  constructor(provider: string, channel: string) {
    super(
      {
        error: 'PROVIDER_UNAVAILABLE',
        message: `Provider ${provider} for channel ${channel} is currently unavailable`,
        provider,
        channel,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

export class RegulatoryViolationException extends HttpException {
  constructor(detail: string) {
    super(
      {
        error: 'REGULATORY_VIOLATION',
        message: `Regulatory constraint violated: ${detail}`,
        detail,
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

export class FrequencyCapExceededException extends HttpException {
  constructor(userId: string, capType: string) {
    super(
      {
        error: 'FREQUENCY_CAP_EXCEEDED',
        message: `User ${userId} has exceeded the ${capType} frequency cap`,
        userId,
        capType,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
