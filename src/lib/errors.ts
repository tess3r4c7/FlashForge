// Application-level errors that carry their own HTTP status code.
//
// Services throw these; the global error handler in app.ts turns them into
// HTTP responses. This keeps services free of HTTP details (no `reply` objects)
// and keeps routes free of fragile `if (message === "...")` string matching.

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 404 — the thing you asked for does not exist. */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, message);
  }
}

/** 403 — it exists, but you are not allowed to act on it. */
export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(403, message);
  }
}

/**
 * 409 — the request is valid, but it conflicts with the current state
 * of the data (out of stock, order already paid, order already cancelled...).
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
  }
}

/**
 * 422 — the request is well-formed but semantically wrong, e.g. reusing an
 * Idempotency-Key with a DIFFERENT request body (a client bug).
 */
export class UnprocessableEntityError extends AppError {
  constructor(message: string) {
    super(422, message);
  }
}
