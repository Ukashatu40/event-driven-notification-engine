// src/dashboard/dashboard.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DashboardGateway } from './dashboard.gateway';
import { WsJwtGuard } from './ws-jwt.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('app.jwt.secret'),
      }),
    }),
  ],
  providers: [DashboardGateway, WsJwtGuard],
  exports: [DashboardGateway],
})
export class DashboardModule {}
