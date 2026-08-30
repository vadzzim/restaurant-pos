import type { PresenceReport } from '@pos/contracts';
import { z } from 'zod';

/**
 * The presence heartbeat (§16: active terminals with their pending counts).
 *
 * The client is the only thing that knows two of these fields — its own pending-mutation queue
 * depth and whether its §18 offline switch is on — so presence is *reported*, not inferred from the
 * connection. The server supplies what the client cannot forge usefully: the source, the socket id
 * where there is one, and the timestamp.
 *
 * One schema for both paths. Since M13 a report arrives either over the socket or as
 * `POST /api/presence` from a terminal on the polling transport, and two copies of these bounds
 * would be two places for the next field to be validated once.
 *
 * `pendingCount` is bounded rather than merely non-negative: this value is written straight into a
 * Redis entry that a debug page renders, and an unbounded number from a client is an unbounded
 * number on a screen.
 */
export const presenceReportSchema: z.ZodType<PresenceReport> = z.object({
  terminalId: z.string().min(1).max(64),
  restaurantId: z.string().min(1).max(64),
  role: z.enum(['pos', 'kitchen']),
  pendingCount: z.number().int().min(0).max(100_000),
  offline: z.boolean(),
});
