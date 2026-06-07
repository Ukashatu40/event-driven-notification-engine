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
  coverageThreshold: {
    global: {
      lines: 70,
      functions: 70,
    },
  },
};

export default config;
