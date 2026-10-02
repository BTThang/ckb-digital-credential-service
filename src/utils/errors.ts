/**
 * Application level errors. Anything thrown that is not an `AppError` is
 * treated as an unexpected error and reported as a generic 500 so that internal
 * details (stack traces, RPC payloads) never leak to API consumers.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

/**
 * No valid, unexpired session accompanied the request.
 *
 * Distinct from `ForbiddenError` because the remedy is different: the caller
 * needs to sign in, not to be granted more access.
 */
export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required", details?: unknown) {
    super(401, "UNAUTHORIZED", message, details);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, details?: unknown) {
    super(403, "FORBIDDEN", message, details);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super(404, "NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, "CONFLICT", message, details);
    this.name = "ConflictError";
  }
}

/**
 * Raised when the CKB RPC node cannot answer. The API surfaces this as
 * `503` / `UNABLE_TO_VERIFY` instead of pretending a credential is invalid.
 */
export class CkbUnavailableError extends AppError {
  constructor(message: string, details?: unknown) {
    super(503, "CKB_UNAVAILABLE", message, details);
    this.name = "CkbUnavailableError";
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
