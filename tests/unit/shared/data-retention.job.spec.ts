// tests/unit/shared/data-retention.job.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { DataRetentionJob } from '../../../src/shared/jobs/data-retention.job';

describe('DataRetentionJob (spec A10.2 — 90-day PII scrub)', () => {
  const executeRaw = jest.fn();
  const deleteMany = jest.fn();
  const job = new DataRetentionJob({
    $executeRaw: executeRaw,
    deadLetterQueue: { deleteMany },
  } as never);

  beforeEach(() => jest.resetAllMocks());

  const sqlOf = () => (executeRaw.mock.calls[0][0] as string[]).join('?');

  it('scrubs personalisation_data AND rendered_content (both hold PII) for rows older than the cutoff', async () => {
    executeRaw.mockResolvedValue(3);
    await job.scrubExpiredPersonalisationData();
    const sql = sqlOf();
    expect(sql).toMatch(/"personalisationData" = jsonb_build_object/);
    expect(sql).toMatch(/"renderedContent" = NULL/);
    expect(sql).toMatch(/"createdAt" < /);
  });

  it('uses COALESCE so rows with no marker are NOT skipped (the bug: NOT(NULL) matched nothing)', async () => {
    executeRaw.mockResolvedValue(0);
    await job.scrubExpiredPersonalisationData();
    const sql = sqlOf();
    expect(sql).toMatch(
      /COALESCE\("personalisationData" ->> 'retention_scrubbed', 'false'\) <> 'true'/,
    );
    expect(sql).not.toMatch(/NOT \(/);
  });

  it('is idempotent: rows already scrubbed by retention or by an erasure request are left alone', async () => {
    executeRaw.mockResolvedValue(0);
    await job.scrubExpiredPersonalisationData();
    expect(sqlOf()).toMatch(/'retention_scrubbed'.*'scrubbed'/s);
  });

  it('passes a cutoff 90 days back', async () => {
    executeRaw.mockResolvedValue(0);
    await job.scrubExpiredPersonalisationData();
    const cutoff = executeRaw.mock.calls[0]
      .slice(1)
      .find((v: unknown) => v instanceof Date) as Date;
    const days = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
  });

  it('never crashes the process if the scrub fails', async () => {
    executeRaw.mockRejectedValue(new Error('deadlock'));
    await expect(
      job.scrubExpiredPersonalisationData(),
    ).resolves.toBeUndefined();
  });

  it('cleans up resolved DLQ entries older than 180 days, and only resolved ones', async () => {
    deleteMany.mockResolvedValue({ count: 4 });
    await job.cleanupResolvedDlqEntries();
    const where = deleteMany.mock.calls[0][0].where;
    expect(where.resolved).toBe(true);
    expect(
      (Date.now() - where.resolvedAt.lt.getTime()) / 86_400_000,
    ).toBeGreaterThan(179.9);
  });

  it('survives a failing DLQ cleanup', async () => {
    deleteMany.mockRejectedValue(new Error('x'));
    await expect(job.cleanupResolvedDlqEntries()).resolves.toBeUndefined();
  });
});
