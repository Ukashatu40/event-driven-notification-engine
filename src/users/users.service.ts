// src/users/users.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { PaginatedResponse, paginate } from '../shared/dto/pagination.dto';
import { ListUsersDto } from './dto/list-users.dto';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a directory listing may show. Never phone/email — even ciphertext should not leave this endpoint. */
export interface UserSummary {
  id: string;
  name: string;
  market: string;
  language: string;
  accountType: string;
  isActive: boolean;
  createdAt: Date;
}

const SUMMARY_SELECT = {
  id: true,
  name: true,
  market: true,
  language: true,
  accountType: true,
  isActive: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Directory search for picking a user to work with (spec has no such
   * endpoint; the console needs one rather than requiring a raw UUID).
   *
   * `name` is the only free-text-searchable field — phone and email are
   * AES-256-GCM encrypted at rest (see PiiService) and reachable only by an
   * exact HMAC blind-index match, never a partial one, so LIKE/ILIKE is not
   * an option for them without decrypting every row.
   */
  async list(query: ListUsersDto): Promise<PaginatedResponse<UserSummary>> {
    const search = query.search?.trim();

    const where = !search
      ? {}
      : UUID_RE.test(search)
        ? { id: search }
        : { name: { contains: search, mode: 'insensitive' as const } };

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: SUMMARY_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginate(data, total, query);
  }
}
