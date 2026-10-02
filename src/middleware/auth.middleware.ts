import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { SessionService } from "../services/session.service.js";
import type { UserRecord } from "../types/domain.js";
import { readCookie } from "../utils/cookies.js";

/**
 * A request that has been through {@link requireAuth}.
 *
 * The identity is attached by the middleware and nowhere else - there is no
 * route that reads an id from the body or query, which is what makes "a user
 * cannot edit another user's profile" a structural property rather than a
 * rule each handler has to remember.
 */
export interface AuthedRequest extends Request {
  auth?: {
    sessionId: number;
    user: UserRecord;
  };
}

/** Reads the raw session cookie from a request. */
export function sessionTokenFrom(
  req: Request,
  cookieName: string,
): string | undefined {
  return readCookie(req.headers, cookieName);
}

/**
 * Rejects anything without a live session.
 *
 * Note what is *not* here: no `OPTIONS` bypass, no origin check. `SameSite`
 * plus the strict CORS allow-list already prevent a cross-site POST from
 * carrying the cookie, and adding a second mechanism here would only create
 * ways to get it wrong.
 */
export function requireAuth(
  sessions: SessionService,
  cookieName: string,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const resolved = sessions.require(
      sessionTokenFrom(req, cookieName),
    );
    (req as AuthedRequest).auth = resolved;
    next();
  };
}

/** Narrowing accessor for handlers mounted behind {@link requireAuth}. */
export function currentUser(req: Request): UserRecord {
  const auth = (req as AuthedRequest).auth;
  if (!auth) {
    // Unreachable through the router; kept so a future mount that forgets the
    // middleware fails loudly instead of acting on `undefined`.
    throw new Error("requireAuth middleware is missing on this route");
  }
  return auth.user;
}