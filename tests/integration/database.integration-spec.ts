// tests/integration/database.integration-spec.ts
//
// Facts about the REAL database schema that unit tests with mocks cannot prove.
import { rawPool } from '../helpers/infra';
import type { Pool } from 'pg';

const suite = process.env.INFRA_UP === 'true' ? describe : describe.skip;

suite('database schema (integration)', () => {
  let pool: Pool;
  const q = async <T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ) => (await pool.query(sql, params)).rows as T[];

  beforeAll(() => {
    pool = rawPool();
  });
  afterAll(async () => {
    await pool.end();
  });

  describe('notifications is partitioned by month (spec A8.1)', () => {
    it('is a partitioned table with PRIMARY KEY (id, "createdAt")', async () => {
      const [t] = await q<{ relkind: string }>(
        `select relkind from pg_class where relname = 'notifications'`,
      );
      expect(t.relkind).toBe('p');
      const [pk] = await q<{ def: string }>(
        `select pg_get_constraintdef(oid) def from pg_constraint where conrelid = 'notifications'::regclass and contype = 'p'`,
      );
      expect(pk.def).toBe('PRIMARY KEY (id, "createdAt")');
    });

    it('has monthly UTC partitions ahead of the calendar plus a default safety net', async () => {
      const parts = await q<{ name: string; bounds: string }>(
        `select c.relname name, pg_get_expr(c.relpartbound, c.oid) bounds from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'notifications'::regclass order by 1`,
      );
      expect(parts.map((p) => p.name)).toContain('notifications_default');
      const monthly = parts.filter((p) =>
        /^notifications_y\d{4}m\d{2}$/.test(p.name),
      );
      expect(monthly.length).toBeGreaterThanOrEqual(4);
      const now = new Date();
      const thisMonth = `notifications_y${now.getUTCFullYear()}m${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      expect(monthly.map((p) => p.name)).toContain(thisMonth);
    });

    it('ensure_notification_partitions() is idempotent', async () => {
      await q(`select ensure_notification_partitions(0, 3)`);
      const [again] = await q<{ n: number }>(
        `select ensure_notification_partitions(0, 3) n`,
      );
      expect(again.n).toBe(0);
    });

    it('a time-range query is pruned to a single partition (spec Question 5 evidence)', async () => {
      const plan = (
        await q<{ 'QUERY PLAN': string }>(
          `explain select count(*) from notifications where "createdAt" >= date_trunc('month', now()) and "createdAt" < date_trunc('month', now()) + interval '1 month'`,
        )
      )
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      const scanned = plan.match(/notifications_y\d{4}m\d{2}/g) ?? [];
      expect(new Set(scanned).size).toBe(1);
    });

    it('carries every index the spec lists (A8.2)', async () => {
      const idx = (
        await q<{ indexdef: string }>(
          `select indexdef from pg_indexes where tablename = 'notifications'`,
        )
      )
        .map((r) => r.indexdef)
        .join('\n');
      expect(idx).toMatch(/\("userId", status, channel\)/); // composite user query
      expect(idx).toMatch(/\("eventType", "createdAt"\)/); // analytics aggregation
      expect(idx).toMatch(/USING brin \("createdAt"\)/); // BRIN time-range
      expect(idx).toMatch(/USING gin \("personalisationData"\)/); // JSONB
      expect(idx).toMatch(
        /WHERE \(status = ANY \(ARRAY\['QUEUED'::"NotificationStatus", 'RETRYING'::"NotificationStatus"\]\)\)/,
      ); // partial worker index
    });
  });

  describe('PII at rest (spec A10.2)', () => {
    it('no user has a plaintext phone or email once the backfill has run', async () => {
      const [r] = await q<{ n: string }>(
        `select count(*) n from users where phone !~ '^enc:v1:' or email !~ '^enc:v1:'`,
      );
      expect(Number(r.n)).toBe(0);
    });

    it('every ACTIVE user has at least one blind index', async () => {
      // GDPR erasure (NotificationsService.eraseUserData) deliberately clears both
      // hashes on an erased user — that's what makes the old phone/email
      // unlookupable and frees the number for re-registration — and sets
      // isActive: false in the same write, so that state is excluded here.
      //
      // Self-service sign-up (SignupService) legitimately creates a user with
      // only ONE of the two: someone who signs up with email and never gives
      // a phone has phoneHash = null on purpose, not a bug — so the
      // invariant is "not BOTH null", not "both present" (that was true only
      // by coincidence, when every user came from the bulk seed script, which
      // always fabricates both).
      const [r] = await q<{ n: string }>(
        `select count(*) n from users where "isActive" = true and "phoneHash" is null and "emailHash" is null`,
      );
      expect(Number(r.n)).toBe(0);
    });

    it('an erased user has NO blind indexes left (unlookupable, spec A10.2)', async () => {
      const [r] = await q<{ n: string }>(
        `select count(*) n from users where "isActive" = false and ("phoneHash" is not null or "emailHash" is not null)`,
      );
      expect(Number(r.n)).toBe(0);
    });

    it('the database itself refuses two users with the same phone or email hash', async () => {
      await pool.query(
        `insert into users (id, name, phone, email, "phoneHash", "emailHash", "updatedAt")
         values (gen_random_uuid(), 'seed-for-dup-test', 'enc:v1:a', 'enc:v1:b', $1, $2, now()) on conflict do nothing`,
        [`seed-phone-${Date.now()}`, `seed-email-${Date.now()}`],
      );
      const [u] = await q<{ id: string; phoneHash: string; emailHash: string }>(
        `select id, "phoneHash", "emailHash" from users where "phoneHash" is not null limit 1`,
      );
      const insert = (over: string) =>
        pool.query(
          `insert into users (id, name, phone, email, "phoneHash", "emailHash", "updatedAt") values (gen_random_uuid(), 'dup', 'enc:v1:x', 'enc:v1:y', ${over}, now())`,
        );
      await expect(
        insert(`'${u.phoneHash}', 'fresh-${Date.now()}'`),
      ).rejects.toThrow(/duplicate key/);
      await expect(
        insert(`'fresh-${Date.now()}', '${u.emailHash}'`),
      ).rejects.toThrow(/duplicate key/);
    });

    it('stored ciphertext is not the plaintext and is not derivable by inspection', async () => {
      const [u] = await q<{ phone: string }>(`select phone from users limit 1`);
      expect(u.phone).toMatch(/^enc:v1:[A-Za-z0-9+/=]{40,}$/);
      expect(u.phone).not.toMatch(/\+\d{6,}/);
    });
  });

  describe('consent log is append-only (spec C3.3)', () => {
    const anyUser = async () => {
      const [u] = await q<{ id: string }>(`select id from users limit 1`);
      return u.id;
    };
    const insertConsent = async () => {
      const id = await anyUser();
      const [r] = await q<{ id: string }>(
        `insert into consent_records (id, "userId", channel, "consentType", "consentText", "ipAddress", granted)
         values (gen_random_uuid(), $1, 'sms', 'OPT_IN', 'integration test consent text', '10.0.0.1', true) returning id`,
        [id],
      );
      return r.id;
    };
    /** Test rows cannot be deleted normally — that is the point. A DBA can, via the replica role. */
    const purge = async (id: string) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(`set local session_replication_role = replica`);
        await c.query(`delete from consent_records where id = $1`, [id]);
        await c.query('commit');
      } finally {
        c.release();
      }
    };

    it('refuses UPDATE, DELETE and TRUNCATE at the database', async () => {
      const id = await insertConsent();
      await expect(
        pool.query(`update consent_records set granted = false where id = $1`, [
          id,
        ]),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query(`delete from consent_records where id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
      await expect(pool.query(`truncate consent_records`)).rejects.toThrow(
        /append-only/,
      );
      const [still] = await q<{ granted: boolean }>(
        `select granted from consent_records where id = $1`,
        [id],
      );
      expect(still.granted).toBe(true);
      await purge(id);
    });

    it('still allows INSERT — withdrawal is a NEW record, and the history keeps both', async () => {
      const id = await insertConsent();
      const uid = await anyUser();
      const [out] = await q<{ id: string }>(
        `insert into consent_records (id, "userId", channel, "consentType", "consentText", "ipAddress", granted)
         values (gen_random_uuid(), $1, 'sms', 'OPT_OUT', 'integration test withdrawal text', '10.0.0.1', false) returning id`,
        [uid],
      );
      const rows = await q<{ granted: boolean }>(
        `select granted from consent_records where id = any($1)`,
        [[id, out.id]],
      );
      expect(rows.map((r) => r.granted).sort()).toEqual([false, true]);
      await purge(id);
      await purge(out.id);
    });

    it('has the new notification states and the consent evidence column', async () => {
      const labels = (
        await q<{ e: string }>(
          `select unnest(enum_range(null::"NotificationStatus"))::text e`,
        )
      ).map((r) => r.e);
      expect(labels).toEqual(
        expect.arrayContaining(['NO_CONSENT', 'DIGEST_PENDING', 'DIGESTED']),
      );
      const cols = (
        await q<{ column_name: string }>(
          `select column_name from information_schema.columns where table_name = 'notifications'`,
        )
      ).map((r) => r.column_name);
      expect(cols).toContain('consentRecordId');
    });
  });

  describe('dead-letter queue', () => {
    it('classifies every entry TRANSIENT | PERMANENT | CONFIGURATION', async () => {
      const bad = await q(
        `select 1 from dead_letter_queue where "failureClass" not in ('TRANSIENT','PERMANENT','CONFIGURATION')`,
      );
      expect(bad).toHaveLength(0);
    });
  });

  describe('migrations', () => {
    it('all migrations are applied and none failed', async () => {
      const rows = await q<{
        migration_name: string;
        finished_at: Date | null;
      }>(
        `select migration_name, finished_at from _prisma_migrations order by migration_name`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(8);
      expect(rows.filter((r) => !r.finished_at)).toEqual([]);
      expect(rows.map((r) => r.migration_name)).toEqual(
        expect.arrayContaining([
          '20260921000001_partition_notifications',
          '20260921000002_encrypt_user_pii',
          '20260921000003_nigeria_market_languages',
          '20260921000004_dlq_failure_class',
          '20260922000001_consent_and_digest',
        ]),
      );
    });
  });
});
