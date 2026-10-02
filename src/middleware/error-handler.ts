import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { logger, safeStringify } from "../utils/logger.js";
import { AppError, errorMessage, isAppError } from "../utils/errors.js";

export function notFoundHandler(
  req: Request,
  res: Response,
): void {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `No route matches ${req.method} ${req.originalUrl}`,
    },
  });
}

/**
 * Terminal error middleware.
 *
 * Only `AppError` instances expose their message; anything else becomes a
 * generic 500 so internal failures never leak implementation details.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: error.issues,
      },
    });
    return;
  }

  if (isAppError(error)) {
    if (error.status >= 500) {
      logger.error(`${req.method} ${req.originalUrl} -> ${error.code}`, {
        message: error.message,
        details: safeStringify(error.details),
      });
    } else {
      logger.debug(`${req.method} ${req.originalUrl} -> ${error.code}: ${error.message}`);
    }

    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, {
    message: errorMessage(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  const fallback: AppError = new AppError(
    500,
    "INTERNAL_ERROR",
    "An unexpected error occurred",
  );
  res.status(fallback.status).json({
    error: { code: fallback.code, message: fallback.message },
  });
}
