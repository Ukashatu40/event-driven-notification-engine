// jest.config.ts
import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    '!src/main.ts',
    '!src/**/*.module.ts',
    '!src/**/*.dto.ts',
    '!src/database/seeds/**', // one-off CLI scripts, exercised by running them
    '!src/**/index.ts', // barrels
    '!src/infrastructure/**',
  ],
  coverageDirectory: 'coverage',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  moduleNameMapper: {
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@notifications/(.*)$': '<rootDir>/src/notifications/$1',
    '^@delivery/(.*)$': '<rootDir>/src/delivery/$1',
    '^@compliance/(.*)$': '<rootDir>/src/compliance/$1',
    '^@templates/(.*)$': '<rootDir>/src/templates/$1',
    '^@analytics/(.*)$': '<rootDir>/src/analytics/$1',
    '^@infrastructure/(.*)$': '<rootDir>/src/infrastructure/$1',
  },
  // Spec Day 13: minimum 80% coverage. Ratcheted up as coverage improved —
  // lowering these is a deliberate, reviewable act, not a quiet way to go green.
  coverageThreshold: {
    global: {
      lines: 80,
      statements: 80,
      functions: 75,
      branches: 60,
    },
  },
};

export default config;
