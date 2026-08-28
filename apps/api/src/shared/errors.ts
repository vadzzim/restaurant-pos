import type { ApiErrorResponse } from '@pos/contracts';

/** The §17 error model: a typed code, a human message, no stack traces in responses. */
export class ApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
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
