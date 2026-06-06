// src/infrastructure/database/database.module.ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global() // available everywhere without re-importing
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
