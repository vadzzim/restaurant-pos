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

/** A unique violation is a normal outcome on this path, not a crash: two clients raced. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const pgError = error as PostgresError;
  if (pgError.code !== '23505') {
    return false;
  }

  return constraint === undefined || pgError.constraint === constraint;
}
