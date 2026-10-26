/** An error that maps to an HTTP answer. Everything else is a 500 with a generic message. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly issues?: { path: string; message: string }[],
    readonly headers?: Record<string, string>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
