// tests/unit/users/users.service.spec.ts
jest.mock('../../../src/infrastructure/database/prisma.service', () => ({
  PrismaService: class MockPrismaService {},
}));

import { UsersService } from '../../../src/users/users.service';

describe('UsersService.list', () => {
  const prisma = { user: { findMany: jest.fn(), count: jest.fn() } };
  const service = new UsersService(prisma as never);
  const dto = (search?: string) =>
    ({ search, page: 1, limit: 20, skip: 0 }) as never;

  beforeEach(() => jest.resetAllMocks());

  it('matches a UUID search as an exact id, not a name search', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);
    const id = '36d89330-b487-4835-a231-197dc9834cae';

    await service.list(dto(id));

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id } }),
    );
  });

  it('matches free text as a case-insensitive partial name search', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);

    await service.list(dto('ngozi'));

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: { contains: 'ngozi', mode: 'insensitive' } },
      }),
    );
  });

  it('lists everyone when no search is given', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);

    await service.list(dto());

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('never selects phone or email — not even the encrypted ciphertext', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);

    await service.list(dto());

    const select = prisma.user.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty('phone');
    expect(select).not.toHaveProperty('email');
    expect(select).not.toHaveProperty('phoneHash');
    expect(select).not.toHaveProperty('emailHash');
  });

  it('paginates using the requested page and limit', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u-1' }]);
    prisma.user.count.mockResolvedValue(37);

    const result = await service.list({
      search: undefined,
      page: 2,
      limit: 10,
      skip: 10,
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
    expect(result.meta).toEqual({
      total: 37,
      page: 2,
      limit: 10,
      totalPages: 4,
    });
  });
});
