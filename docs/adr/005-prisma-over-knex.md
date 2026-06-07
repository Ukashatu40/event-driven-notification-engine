<!-- docs/adr/005-prisma-over-knex.md -->

# ADR-005: Prisma ORM over Knex.js

**Date:** 2025-03  
**Status:** Accepted

## Context

The project specification lists both Prisma and Knex.js as acceptable ORM options.

## Decision

Use Prisma.

## Consequences

**Positive:**

- Generated TypeScript types from schema eliminate entire class of runtime type errors
- Prisma Migrate provides reproducible, version-controlled schema evolution
- Prisma Client API is type-safe at compile time — incorrect queries fail at build, not runtime
- Schema-first approach makes database design reviewable without reading SQL

**Negative:**

- Less control over raw SQL for complex queries — mitigated with `prisma.$queryRaw`
- Prisma generates larger bundles than Knex — acceptable at our scale

## Alternatives considered

TypeORM — rejected due to decorator-heavy API and known issues with complex relation queries at scale.
