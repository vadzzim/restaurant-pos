import type { ApiErrorCode, ApiErrorResponse } from '@pos/contracts';
import type { ZodError } from 'zod';

/**
 * The §17 error model: a typed code, a human message, no stack traces in responses.
 *
 * `code` is `ApiErrorCode`, not `string`, so the set of codes a client may see is a closed list in
 * `@pos/contracts` that both sides compile against. A §5 domain outcome — a conflict, a tenant
 * rejection, an id reuse — is never an `ApiError`: it carries a snapshot and a reason the offline
 * queue branches on (§14.1), and this envelope has room for neither.
 */
export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toResponse(): ApiErrorResponse {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

interface PostgresError {
  code: string;
  constraint?: string;
}

function asPostgresError(error: unknown): PostgresError | undefined {
  // Drizzle wraps driver failures in a DrizzleQueryError whose `cause` is the pg DatabaseError,
  // so the code we need is one or more links down the chain, never on the thrown object itself.
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && typeof (current as { code: unknown }).code === 'string') {
      return current as PostgresError;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/** A unique violation is a normal outcome on this path, not a crash: two clients raced. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = asPostgresError(error);

  if (pgError?.code !== '23505') {
    return false;
  }

  return constraint === undefined || pgError.constraint === constraint;
}

/**
 * Every boundary in the API validates with zod and every failure turns into the same envelope, so
 * the conversion belongs here rather than repeated at each of the five call sites. `issues` is the
 * zod report unchanged: it names the failing path, which is what a client needs to fix the call.
 */
export function validationFailed(message: string, error: ZodError): ApiError {
  return new ApiError(400, 'VALIDATION_FAILED', message, { issues: error.issues });
}

interface FastifyLikeError {
  statusCode?: number;
  code?: string;
  message?: string;
}

/**
 * Fastify throws before any route code runs — a body that is not JSON, a payload over the limit —
 * and those errors carry their own 4xx `statusCode`. Treating them as unhandled would answer 500,
 * which tells a client its own malformed request was a server fault: under §14 that is the
 * difference between "fix the payload" and "retry this forever".
 *
 * A 5xx from Fastify is a genuine fault and stays anonymous, like any unhandled error.
 */
export function asClientError(error: unknown): ApiError | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { statusCode, code, message } = error as FastifyLikeError;
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) {
    return undefined;
  }

  return new ApiError(
    statusCode,
    'VALIDATION_FAILED',
    message ?? 'The request could not be read.',
    code === undefined ? undefined : { fastifyCode: code },
  );
}
