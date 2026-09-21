// tests/jest-e2e.config.ts
import type { Config } from 'jest';

/** e2e tests run against REAL Postgres/Redis/Kafka/RabbitMQ — see tests/helpers/infra.ts. */
const config: Config = {
  rootDir: '..',
  roots: ['<rootDir>/tests/e2e'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  moduleFileExtensions: ['js', 'json', 'ts'],
  testEnvironment: 'node',
  globalSetup: '<rootDir>/tests/helpers/global-setup.ts',
  testTimeout: 60_000,
  maxWorkers: 1, // shared infrastructure: run suites one at a time
  forceExit: true, // Kafka/Rabbit clients can hold the loop open after app.close()
};

export default config;
