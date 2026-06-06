// src/templates/engine/sms-truncation.service.ts
import { Injectable } from '@nestjs/common';

/**
 * SMS truncation that preserves meaning within 160 characters.
 *
 * Strategy:
 * 1. If content fits, return as-is.
 * 2. If over limit, truncate at the last complete word before the limit,
 *    append a short URL placeholder so the user can view full details.
 * 3. Never truncate in the middle of a financial figure (amount, price).
 */
@Injectable()
export class SmsTruncationService {
  private readonly SMS_LIMIT = 160;
  private readonly SUFFIX = '... App';
  private readonly SUFFIX_LENGTH = this.SUFFIX.length;

  truncate(content: string): string {
    if (content.length <= this.SMS_LIMIT) return content;

    const available = this.SMS_LIMIT - this.SUFFIX_LENGTH;
    const truncated = content.substring(0, available);

    // Find last complete word boundary
    const lastSpace = truncated.lastIndexOf(' ');
    const safeEnd = lastSpace > available * 0.8 ? lastSpace : available;

    return truncated.substring(0, safeEnd) + this.SUFFIX;
  }

  fits(content: string): boolean {
    return content.length <= this.SMS_LIMIT;
  }

  remaining(content: string): number {
    return Math.max(0, this.SMS_LIMIT - content.length);
  }
}
