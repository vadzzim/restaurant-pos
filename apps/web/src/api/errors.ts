/**
 * A §17 error envelope that came back from the API, surfaced with its code intact.
 *
 * **In its own module, next to `OfflineError` and away from the client**, because the sync engine
 * has to ask `instanceof` about it and the stores' tests replace the whole of `api/client` with a
 * mock. An engine that imported the error from there would be asking a mocked module for a class
 * it does not define — a failure that has nothing to do with what those tests are checking.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}
