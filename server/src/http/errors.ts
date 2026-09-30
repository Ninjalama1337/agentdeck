/** Error carrying an HTTP status + machine-readable code; shaped by the app error handler. */
export class HttpError extends Error {
  statusCode: number;
  code: string;
  expose: boolean;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = statusCode < 500;
  }
}

export function httpError(statusCode: number, code: string, message: string): HttpError {
  return new HttpError(statusCode, code, message);
}

export const notFound = (message = 'Not found'): HttpError => httpError(404, 'NOT_FOUND', message);
