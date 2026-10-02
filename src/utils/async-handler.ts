import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps a route handler so rejected promises reach the Express error
 * middleware instead of becoming unhandled rejections.
 *
 * Synchronous throws are intentionally left to Express (which already catches
 * them) so the wrapper works for both sync and async handlers.
 */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
