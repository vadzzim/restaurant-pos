# 007. Drizzle for relational persistence

Status: accepted
Date: 2026-08-28

## Context

The mutation path depends on explicit PostgreSQL transactions, version-guarded updates, partial
indexes, row claiming, and `FOR UPDATE SKIP LOCKED`.

## Decision

Use Drizzle for schema definitions, migrations, and ordinary queries. Keep concurrency-sensitive
statements as explicit SQL where that makes their guarantees easier to inspect.

## Consequences

Database behavior remains visible and strongly typed. The team owns more SQL and mapping code than
with a higher-level ORM, and must understand PostgreSQL semantics directly.

## Alternatives considered

Prisma was rejected because its higher-level API does not improve the critical transaction and
locking paths. Raw SQL alone was rejected because it would add repetitive mapping and migration
work outside those paths.
