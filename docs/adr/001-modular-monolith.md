# 001. Modular monolith with three processes

Status: accepted
Date: 2026-08-28

## Context

The demo must show HTTP, asynchronous processing, and a browser client without turning a small
interview project into a fleet of independently deployed services.

## Decision

Use one monorepo with exactly three application processes: `web`, `api`, and `worker`. Organize the
backend by domain module so boundaries remain visible inside the API process.

## Consequences

Local startup, shared contracts, and cross-cutting changes stay simple. The API remains a single
deployment unit, so modules cannot be scaled or released independently without later extraction.

## Alternatives considered

Separate services per domain were rejected because they add deployment and network failure modes
without helping this demo. A single process was rejected because background consumers and HTTP
traffic have different lifecycle and scaling needs.
