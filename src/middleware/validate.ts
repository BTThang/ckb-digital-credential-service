import type { NextFunction, Request, Response } from "express";
import { type ZodError, type ZodType } from "zod";

import { ValidationError } from "../utils/errors.js";

type Source = "body" | "query" | "params";

function formatIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

/**
 * Validates and *replaces* the given request section with the parsed value.
 *
 * Because the parsed output is assigned back, downstream handlers work with
 * coerced, trimmed and whitelisted data only - unknown keys are rejected by
 * the `.strict()` schemas, so a client can never smuggle `status: "active"`
 * or `ownerAddress` into a create/update payload.
 */
export function validate<T>(
  schema: ZodType<T>,
  source: Source = "body",
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      next(
        new ValidationError(
          `Invalid request ${source}`,
          formatIssues(result.error),
        ),
      );
      return;
    }

    if (source === "query") {
      // Express 5 exposes `req.query` as a getter-only property.
      Object.defineProperty(req, "query", {
        value: result.data,
        writable: true,
        configurable: true,
      });
    } else if (source === "params") {
      Object.defineProperty(req, "params", {
        value: result.data,
        writable: true,
        configurable: true,
      });
    } else {
      req.body = result.data;
    }

    next();
  };
}
