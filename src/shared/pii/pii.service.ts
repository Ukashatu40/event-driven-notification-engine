// src/shared/pii/pii.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  blindIndex,
  decryptPii,
  encryptPii,
  isEncryptedPii,
} from '../utils/pii-masker.util';

/**
 * Column-level encryption for phone numbers and email addresses (spec A10.2).
 *
 * - encrypt()/decrypt(): AES-256-GCM, key from PII_ENCRYPTION_KEY (64 hex chars).
 * - phoneHash()/emailHash(): HMAC blind indexes, key from PII_HASH_KEY, stored
 *   next to the ciphertext so uniqueness and lookups keep working.
 *
 * decrypt() passes a value that is not in the encrypted format straight
 * through. That is deliberate, and only for the rollout window between
 * deploying this code and running `npm run pii:encrypt` on existing rows; it
 * logs a warning so plaintext left behind is visible rather than silent.
 */
@Injectable()
export class PiiService {
  private readonly logger = new Logger(PiiService.name);
  private readonly encryptionKey: Buffer;
  private readonly hashKey: Buffer;
  private warnedPlaintext = false;

  constructor(config: ConfigService) {
    this.encryptionKey = Buffer.from(
      config.get<string>('PII_ENCRYPTION_KEY') ?? '',
      'hex',
    );
    this.hashKey = Buffer.from(
      config.get<string>('PII_HASH_KEY') ?? '',
      'utf8',
    );

    if (this.encryptionKey.length !== 32) {
      throw new Error(
        'PII_ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
          'Generate one with: openssl rand -hex 32',
      );
    }
    if (this.hashKey.length < 32) {
      throw new Error(
        'PII_HASH_KEY must be at least 32 characters. ' +
          'Generate one with: openssl rand -hex 32',
      );
    }
  }

  encrypt(plaintext: string): string {
    return encryptPii(plaintext, this.encryptionKey);
  }

  decrypt(stored: string): string {
    if (!isEncryptedPii(stored)) {
      if (!this.warnedPlaintext) {
        this.warnedPlaintext = true;
        this.logger.warn(
          'Found un-encrypted PII in the database — run `npm run pii:encrypt`',
        );
      }
      return stored;
    }
    return decryptPii(stored, this.encryptionKey);
  }

  /** Phones are compared without spaces/dashes. */
  phoneHash(phone: string): string {
    return blindIndex(`phone:${phone.replace(/[\s-]/g, '')}`, this.hashKey);
  }

  /** Emails are case-insensitive. */
  emailHash(email: string): string {
    return blindIndex(`email:${email.trim().toLowerCase()}`, this.hashKey);
  }

  /**
   * Columns to persist for a user's contact details: ciphertext for display /
   * sending, blind index for uniqueness and lookup.
   */
  protectContact(contact: { phone?: string; email?: string }): {
    phone?: string;
    phoneHash?: string;
    email?: string;
    emailHash?: string;
  } {
    return {
      ...(contact.phone !== undefined && {
        phone: this.encrypt(contact.phone),
        phoneHash: this.phoneHash(contact.phone),
      }),
      ...(contact.email !== undefined && {
        email: this.encrypt(contact.email),
        emailHash: this.emailHash(contact.email),
      }),
    };
  }
}
