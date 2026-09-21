// tests/helpers/global-setup.ts — runs once before the e2e/integration suites.
import { infraAvailable } from './infra';

export default async function globalSetup(): Promise<void> {
  const up = await infraAvailable();
  process.env.INFRA_UP = String(up);
  if (!up) {
    // eslint-disable-next-line no-console
    console.warn(
      '\n⚠ Infrastructure not reachable — e2e/integration suites will be SKIPPED. Run `docker compose up -d`.\n',
    );
  }
}
