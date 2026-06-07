<!-- docs/adr/001-nestjs-fastify-adapter.md -->

# ADR-001: NestJS with Fastify Adapter

**Date:** 2025-03  
**Status:** Accepted

## Context

The project required a Node.js backend framework capable of handling high-throughput notification delivery (2M+ daily). Two options were evaluated: NestJS with Express adapter vs NestJS with Fastify adapter.

## Decision

Use NestJS with the Fastify adapter (`@nestjs/platform-fastify`).

## Consequences

**Positive:**

- Fastify delivers 2–3× higher throughput than Express under load, directly supporting the 450K simultaneous alerts scenario
- NestJS DI container, decorators, guards, and interceptors remain available
- Swagger, validation pipes, and all NestJS ecosystem packages work unchanged
- Single line change to switch adapter if needed

**Negative:**

- Some Express-specific middleware requires adaptation for Fastify
- Slightly less community documentation for Fastify-specific NestJS patterns

## Alternatives considered

Pure Fastify without NestJS — rejected because it lacks the DI container and module system needed for clean architecture at this scale.
