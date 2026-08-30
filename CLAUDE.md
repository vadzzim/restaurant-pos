# Restaurant POS Distributed Systems Demo

A demo application built for a **Lead Full-Stack Engineer (Node.js & Vue)** interview at
IDT / National Retail Solutions. Its purpose is to demonstrate distributed-systems engineering:
offline-first clients, concurrent correctness, idempotency, event-driven workflows.
This is NOT a commercial POS product.

## Canonical documents

Read at the start of a session — and nothing else:

- `docs/PROGRESS.md` — current state, and the *First command of the next session* block, which is
  the context pack the previous session wrote for this one. **Hard limit 8 000 characters.**
- `docs/milestones/MXX.md` — the brief for this session. **Cap it at 8 000 characters.**

Read on demand, by `grep` or by line range, never whole:

- `docs/spec.md` — the single source of truth for requirements.
- `docs/MILESTONES.md` — the session plan and progress checklist.
- `docs/adr/` — accepted decisions. Do not revisit them without a reason. **Cap a new ADR at
  2 000 characters.**
- `docs/known-problems.md` — accepted limits, and the P2/P3 review backlog.

**Write-only. Never read these to start a session:**

- `docs/build-log.md` — what broke and how it was fixed. **The single owner of review history**;
  do not keep a second copy of it in `PROGRESS.md`.
- `docs/progress-archive.md` — the frozen pre-M11 `PROGRESS.md` sections. Nothing is appended.

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
   Do not restate in `PROGRESS.md` what `build-log.md`, an ADR or the code already says — link it.
6. No subagents, no workflows — they multiply token spend.
7. Long command output goes to `$TMP/scratchpad`; read it with grep, not in full.
8. **One review pass per milestone, P1s only.** See *Review discipline*. Review rounds are what
   turned a one-commit milestone into five; they are now bounded by rule, not by judgement.

## Session ritual

1. Read `docs/PROGRESS.md` and `docs/milestones/MXX.md`.
2. If `MXX.md` does not exist yet, expand the brief from `MILESTONES.md` into that file first,
   then start work.
3. Implement that milestone and nothing else.
4. Run the Verification block from `MXX.md`. Fix until green.
5. **One review pass**, under *Review discipline* below.
6. Update `PROGRESS.md` — **rewrite it, do not append.** In particular rewrite the
   *First command of the next session* block: it is the whole context pack the next session gets,
   so name the invariants, the traps and the two or three `known-problems.md` entries that
   milestone touches. Thirty lines written by someone who knows the code beats three hundred lines
   of accumulated facts. Append to `build-log.md`; add an ADR if a decision was made.
7. `git add -A && git commit -m "MXX: ..."`.

One milestone = one commit, and every milestone starts from a clean tree.

## Review discipline

Milestones M4, M6 and M10 each ran three to five review rounds, and every round cost a full re-read
of the diff, a fix, a commit and a `build-log.md` entry. Each round was opened by the previous
round's fix. That is the single largest consumer of the usage budget, so it is bounded by rule:

- **One review pass per milestone**, run after the Verification block is green.
- **Fix P1s only** — a correctness, concurrency, data-loss or security defect, or something that
  breaks the milestone's own Verification block.
- **P2 and P3 findings are not fixed.** Write each as one line under *Review backlog* in
  `docs/known-problems.md`: what, where, and what would prove it. Then stop.
- **Do not open a second round** to check the P1 fixes. The tests that cover them are the check.
- The backlog is swept in a dedicated pass every three or four milestones, when it is cheaper to
  reload one context for ten small findings than to carry each one at the time.

If a P1 fix is large enough to need its own review, that is a signal the milestone was too big —
say so in `PROGRESS.md` and cut the next one, rather than adding a round here.

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
