# Restaurant POS Distributed Systems Demo

A demo application built for a **Lead Full-Stack Engineer (Node.js & Vue)** interview at
IDT / National Retail Solutions. Its purpose is to demonstrate distributed-systems engineering:
offline-first clients, concurrent correctness, idempotency, event-driven workflows.
This is NOT a commercial POS product.

## Canonical documents

- `docs/spec.md` — the single source of truth for requirements.
- `docs/MILESTONES.md` — the session plan and progress checklist.
- `docs/PROGRESS.md` — current state: what is done, what is next, known problems.
- `docs/milestones/MXX.md` — the brief for the current session.
- `docs/build-log.md` — what broke and how it was fixed.
- `docs/adr/` — accepted decisions. Do not revisit them without a reason.

## Context budget rules (the user is on the Pro plan)

1. **Never read `prompt_01.md` or `prompt_02.md`.** They are the ~54k-character source prompts,
   already distilled into `docs/spec.md`. The spec is the only canon.
2. **One milestone per session.** Do not run ahead, even when the next step looks adjacent.
   Going beyond the milestone burns the usage limit and produces a dirty commit.
3. **The user starts the infrastructure.** Do not run `docker compose up`, do not pull container
   logs — they arrive in full and cannot be grepped cheaply. If infrastructure is needed, ask the
   user to bring it up and paste the error. Reproducibility is covered instead by
   `pnpm verify:integration` (built in M6): one scripted command that brings Compose up, waits for
   readiness, runs the integration suite, tears down, and writes its output to a file. Run that
   and read the tail, never a live log stream.
4. **Run tests narrowly**: `pnpm -F api test src/modules/orders`, never the whole monorepo.
5. Do not restate generated files in chat. Do not duplicate code in the reply.
6. No subagents, no workflows — they multiply token spend.
7. Long command output goes to `$TMP/scratchpad`; read it with grep, not in full.

## Session ritual

1. Read `docs/PROGRESS.md` and `docs/milestones/MXX.md`.
2. If `MXX.md` does not exist yet, expand the brief from `MILESTONES.md` into that file first,
   then start work.
3. Implement that milestone and nothing else.
4. Run the Verification block from `MXX.md`. Fix until green.
5. Update `PROGRESS.md` (the handoff!), append to `build-log.md`, add an ADR if a decision was made.
6. `git add -A && git commit -m "MXX: ..."`.

One milestone = one commit, and every milestone starts from a clean tree.

If a session goes off the rails, recover in this order: `git branch wip/MXX` to keep the work
reachable, then `git restore` the specific files that went wrong, or `git revert` a bad commit.
Reach for `git reset --hard` only against the last milestone commit, only after branching, and
only when a targeted fix would cost more than replaying the step.

## Engineering conventions

- Strict TypeScript. `any` is forbidden without an explicit justifying comment.
- Money is integer cents (`totalCents`), never floating point.
- Business logic lives outside HTTP controllers. Controllers stay thin.
- Input validation is zod at the API boundary.
- Logging is pino, JSON, with correlation fields: `traceId requestId restaurantId terminalId
  orderId mutationId eventId`.
- Concurrency-sensitive SQL is explicit, never hidden behind ORM magic.
- Conflict rules live in one domain component, not smeared across the codebase.
- Introduce an abstraction only against a concrete problem. Readability beats elegance.
- `// TODO: implement later` is forbidden in critical functionality.

## Language

All project artifacts — code, comments, `docs/**`, README, ADRs, commit messages — are written
in English. Chat with the user is in Russian.
