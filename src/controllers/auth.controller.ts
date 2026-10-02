import type { NextFunction, Request, Response } from "express";

import type { Env } from "../config/index.js";
import type { AuthService } from "../services/auth.service.js";
import type { SessionService } from "../services/session.service.js";
import { toPublicUser } from "../types/domain.js";
import type {
  AuthNonceRequest,
  AuthVerifyRequest,
} from "../validation/auth.schema.js";
import { sessionTokenFrom } from "../middleware/auth.middleware.js";

export interface AuthControllerDeps {
  auth: AuthService;
  sessions: SessionService;
  env: Env;
}

export function authController(deps: AuthControllerDeps) {
  const { auth, sessions, env } = deps;

  /**
   * `POST /api/auth/nonce`
   *
   * Returns the canonical message to sign. It contains no secret beyond a
   * short-lived, single-use nonce, and it is the *only* challenge the service
   * will ever accept - the client cannot supply its own text.
   */
  function requestNonce(req: Request, res: Response, _next: NextFunction): void {
    const { address } = req.body as AuthNonceRequest;
    const challenge = auth.requestChallenge(address);

    res.json({ data: challenge });
  }

  /**
   * `POST /api/auth/verify`
   *
   * The only place a session is created. The raw token leaves in the cookie and
   * nowhere else: it is not in the body, not in a header, and not in SQLite.
   */
  async function verify(
    req: Request,
    res: Response,
    _next: NextFunction,
  ): Promise<void> {
    const { session, user } = await auth.verify(req.body as AuthVerifyRequest);

    res.setHeader("Set-Cookie", session.cookie);
    res.json({
      data: { authenticated: true, user, expiresAt: session.expiresAt },
    });
  }

  /**
   * `GET /api/auth/me`
   *
   * Restores a session from the cookie. An anonymous caller gets
   * `authenticated: false` with a 200 rather than a 401: "not signed in" is a
   * normal state of the app, not an error.
   */
  function me(req: Request, res: Response, _next: NextFunction): void {
    const resolved = sessions.resolve(
      sessionTokenFrom(req, env.auth.cookie.name),
    );

    if (!resolved) {
      res.json({ data: { authenticated: false, user: null } });
      return;
    }

    res.json({
      data: { authenticated: true, user: toPublicUser(resolved.user) },
    });
  }

  /**
   * `POST /api/auth/logout`
   *
   * Revokes the session server-side *and* clears the cookie. Doing only the
   * latter would leave a live token in the database, and doing only the former
   * would leave the browser replaying it on every request.
   *
   * Idempotent: logging out twice is not an error.
   */
  function logout(req: Request, res: Response, _next: NextFunction): void {
    const cleared = sessions.revoke(
      sessionTokenFrom(req, env.auth.cookie.name),
    );

    res.setHeader("Set-Cookie", cleared);
    res.json({ data: { authenticated: false, user: null } });
  }

  return { requestNonce, verify, me, logout };
}