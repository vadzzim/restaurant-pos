import type { MutationResponse } from '@pos/contracts';
import type { Db } from '@pos/db';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { incrementCounter } from '../../debug/application/counters.js';
import { observeMutation } from '../../observability/prometheus.js';
import { applyMutation, type MutationInput } from '../application/mutation-handler.js';

/**
 * §20's mutation counters, in the one function all three write routes pass through.
 *
 * They are counted from the *outcome* rather than at the branches inside the handler, so a new
 * branch cannot be added without appearing here — the handler decides, this records. `CONFLICT` is
 * deliberately absent: conflicts are counted from `conflict_log`, which is durable and fleet-wide,
 * and two numbers for one fact is how a debug page starts lying.
 */
function countOutcome(status: MutationResponse['status']): void {
  incrementCounter('mutationsReceived');

  switch (status) {
    case 'APPLIED':
      incrementCounter('mutationsApplied');
      return;
    case 'ALREADY_APPLIED':
      // §9: the mutation was applied once, by an earlier request, and this one was answered from
      // `processed_mutations`. It is a prevented duplicate, not a second application.
      incrementCounter('duplicateMutationsPrevented');
      return;
    case 'MUTATION_ID_REUSED':
      incrementCounter('mutationIdReuseRejected');
      return;
    case 'REJECTED':
      incrementCounter('crossTenantRejections');
      return;
    default:
      return;
  }
}

/**
 * The one place a mutation outcome becomes an HTTP reply. Three routes construct mutations — the
 * canonical `POST /api/orders/:orderId/mutations` and the two kitchen adapters of §17 — and they
 * must be indistinguishable to a client: the same status codes, the same §5 bodies, the same
 * correlation fields in the log. Duplicating twelve lines three times is how they drift apart.
 *
 * The adapters therefore carry no rule of their own. They read as domain commands and they
 * validate their own body; everything after that is this function and the handler behind it.
 *
 * This is also the only place §20's correlation fields can be logged together, which is why they
 * are logged here and not in the three routes: a mutation is the one unit of work that knows all
 * of `orderId mutationId restaurantId terminalId` at once. `traceId` is passed *into* the handler,
 * so it is written to `outbox_events.trace_id`, copied onto the `DomainEvent` by the publisher and
 * logged again by both consumers — one header followed across three processes.
 */
export async function executeMutation(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  input: Omit<MutationInput, 'traceId'>,
): Promise<FastifyReply> {
  const outcome = await applyMutation(db, { ...input, traceId: request.traceId });
  const body = outcome.body;

  countOutcome(body.status);
  observeMutation(body.status);

  const fields = {
    orderId: input.orderId,
    mutationId: input.mutationId,
    restaurantId: input.restaurantId,
    terminalId: input.terminalId,
    mutationType: input.type,
    baseVersion: input.baseVersion,
    outcome: body.status,
    httpStatus: outcome.httpStatus,
  };

  // A run of conflicts is the signal an operator is looking for; it must be visible without
  // reading every applied mutation, so the level follows the outcome rather than the transport.
  if (body.status === 'APPLIED' || body.status === 'ALREADY_APPLIED') {
    request.log.info(fields, 'mutation processed');
  } else {
    // `in` rather than a narrowing on `status`: an applied response carries two status literals, so
    // the union does not collapse on the negative branch.
    request.log.warn(
      { ...fields, reason: 'reason' in body ? body.reason : undefined },
      'mutation refused',
    );
  }

  return reply.status(outcome.httpStatus).send(body);
}
