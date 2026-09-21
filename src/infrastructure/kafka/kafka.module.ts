// src/infrastructure/kafka/kafka.module.ts
import { Global, Module } from '@nestjs/common';
import { KafkaService } from './kafka.service';
import { KafkaLagMonitorService } from './kafka-lag-monitor.service';

@Global()
@Module({
  providers: [KafkaService, KafkaLagMonitorService],
  exports: [KafkaService],
})
export class KafkaModule {}
