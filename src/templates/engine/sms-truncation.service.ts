// src/templates/engine/sms-truncation.service.ts
import { Injectable } from '@nestjs/common';

// GSM 03.38 basic character set (each char = 1 septet) ...
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// ... and its extension table (each char costs 2 septets)
const GSM_EXTENDED = '^{}\\[~]|€';

/**
 * SMS truncation that preserves meaning within one SMS segment.
 *
 * A single SMS holds 160 characters ONLY in the GSM-7 alphabet. One character
 * outside it (Devanagari, Tamil, Telugu, or Nigerian-language letters such as
 * ẹ ọ ṣ ị ụ ɓ ɗ ƙ) switches the whole message to UCS-2, which holds just 70.
 * The limit is therefore computed per message, not fixed at 160.
 *
 * Strategy:
 * 1. If content fits, return as-is.
 * 2. If over limit, truncate at the last complete word before the limit,
 *    append a short suffix so the user can view full details in the app.
 */
@Injectable()
export class SmsTruncationService {
  static readonly GSM7_LIMIT = 160;
  static readonly UCS2_LIMIT = 70;
  private readonly SUFFIX = '... App';

  /**
   * Rewrites characters that would push an otherwise-GSM-7 message into UCS-2
   * (and cut its capacity from 160 to 70): the rupee and naira signs are not in
   * the GSM alphabet, and Intl formatting inserts non-breaking spaces.
   */
  toSmsSafe(content: string): string {
    return content
      .replace(/[\u00a0\u202f]/g, ' ')
      .replace(/₹\s*/g, 'Rs ')
      .replace(/₦\s*/g, 'NGN ');
  }

  /** True when every character is in the GSM-7 basic or extension set. */
  isGsm7(content: string): boolean {
    for (const ch of content) {
      if (!GSM_BASIC.includes(ch) && !GSM_EXTENDED.includes(ch)) return false;
    }
    return true;
  }

  /** Length in the unit the limit is measured in (septets or UTF-16 units). */
  encodedLength(content: string): number {
    if (!this.isGsm7(content)) return content.length;
    let n = 0;
    for (const ch of content) n += GSM_EXTENDED.includes(ch) ? 2 : 1;
    return n;
  }

  limitFor(content: string): number {
    return this.isGsm7(content)
      ? SmsTruncationService.GSM7_LIMIT
      : SmsTruncationService.UCS2_LIMIT;
  }

  truncate(content: string): string {
    const limit = this.limitFor(content);
    if (this.encodedLength(content) <= limit) return content;

    const available = limit - this.SUFFIX.length;
    const truncated = content.substring(0, available);

    // Find last complete word boundary
    const lastSpace = truncated.lastIndexOf(' ');
    const safeEnd = lastSpace > available * 0.8 ? lastSpace : available;

    return truncated.substring(0, safeEnd) + this.SUFFIX;
  }

  fits(content: string): boolean {
    return this.encodedLength(content) <= this.limitFor(content);
  }

  remaining(content: string): number {
    return Math.max(0, this.limitFor(content) - this.encodedLength(content));
  }
}
