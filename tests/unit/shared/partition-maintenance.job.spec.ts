// tests/unit/shared/partition-maintenance.job.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { PartitionMaintenanceJob } from '../../../src/shared/jobs/partition-maintenance.job';

describe('PartitionMaintenanceJob', () => {
  const queryRaw = jest.fn();
  let job: PartitionMaintenanceJob;

  beforeEach(() => {
    jest.resetAllMocks();
    job = new PartitionMaintenanceJob({ $queryRaw: queryRaw } as never);
  });

  it('reports how many partitions the database function created', async () => {
    queryRaw.mockResolvedValue([{ created: 2 }]);
    expect(await job.ensurePartitions()).toBe(2);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('runs at startup so a fresh deployment is immediately covered', async () => {
    queryRaw.mockResolvedValue([{ created: 0 }]);
    await job.onModuleInit();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('logs and survives a database failure instead of crashing startup', async () => {
    queryRaw.mockRejectedValue(new Error('function does not exist'));
    await expect(job.ensurePartitions()).resolves.toBe(0);
  });
});
