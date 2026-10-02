import { createHash, randomBytes } from "node:crypto";

import type { AuthRepository } from "../repositories/index.js";
import type { UserRepository } from "../repositories/index.js";
import type { UserRecord } from "../types/domain.js";
import type { Env } from "../config/index.js";
import { serializeCookie, serializeExpiredCookie } from "../utils/cookies.js";
import { UnauthorizedError } from "../utils/errors.js";

export interface IssuedSession {
  /** The raw token. Sent once, in the cookie, and never persisted. */
  token: string;
  expiresAt: string;
  cookie: string;
}

export interface ResolvedSession {
  sessionId: number;
  user: UserRecord;
}

/**
 * Server-side sessions carried by an opaque cookie.
 *
 * The design follows the OWASP session guidance the phase brief cites:
 *
 * - 256 bits of entropy from the CSPRNG, not a JWT, so revocation is possible;
 * - only the SHA-256 digest is stored, so a database leak is not a set of
 *   usable cookies;
 * - `HttpOnly` so script cannot read it, `Secure` in production, `SameSite` to
 *   blunt CSRF;
 * - an absolute expiry checked server-side, not just trusted to the cookie.
 */
export class SessionService {
  constructor(
    private readonly auth: AuthRepository,
    private readonly users: Pick<UserRepository, "findById">,
    private readonly env: Env,
  ) {}

  /** Mints a session for `userId` and renders the `Set-Cookie` value. */
  issue(userId: number): IssuedSession {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.now() + this.env.auth.sessionTtlMs,
    ).toISOString();

    // Expired rows are swept opportunistically; a lazy delete here also keeps a
    // long-lived process from accumulating dead rows forever.
    this.auth.deleteExpiredSessions();
    this.auth.deleteExpiredNonces();

    this.auth.createSession({
      userId,
      sessionHash: SessionService.hashToken(token),
      expiresAt,
    });

    return {
      token,
      expiresAt,
      cookie: this.serializeCookie(token, this.env.auth.sessionTtlMs / 1_000),
    };
  }

  /**
   * Resolves a raw cookie token to its user.
   *
   * Returns `null` for every failure mode - unknown, expired, or orphaned -
   * because a caller must not be able to tell them apart.
   */
  resolve(token: string | undefined): ResolvedSession | null {
    if (!token) return null;

    const session = this.auth.findSessionByHash(
      SessionService.hashToken(token),
    );
    if (!session) return null;

    if (Date.parse(session.expiresAt) <= Date.now()) {
      // Clean up immediately rather than waiting for the next sweep.
      this.auth.deleteSessionByHash(session.sessionHash);
      return null;
    }

    const user = this.users.findById(session.userId);
    if (!user) {
      this.auth.deleteSessionByHash(session.sessionHash);
      return null;
    }

    this.auth.touchSession(session.id);
    return { sessionId: session.id, user };
  }

  /** Like {@link resolve} but throws the 401 that `requireAuth` would throw. */
  require(token: string | undefined): ResolvedSession {
    const resolved = this.resolve(token);
    if (!resolved) throw new UnauthorizedError();
    return resolved;
  }

  /** Invalidates a session and returns the cookie that clears the browser. */
  revoke(token: string | undefined): string {
    if (token) {
      this.auth.deleteSessionByHash(SessionService.hashToken(token));
    }
    return this.clearCookie();
  }

  /** Revokes every session of a user, e.g. after a wallet disconnect. */
  revokeAll(userId: number): string {
    this.auth.deleteSessionsByUserId(userId);
    return this.clearCookie();
  }

  static hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private serializeCookie(value: string, maxAgeSeconds: number): string {
    const { secure, sameSite, path } = this.env.auth.cookie;
    return serializeCookie(this.env.auth.cookie.name, value, {
      maxAge: maxAgeSeconds,
      path,
      httpOnly: true,
      secure,
      sameSite,
    });
  }

  private clearCookie(): string {
    const { secure, sameSite, path } = this.env.auth.cookie;
    return serializeExpiredCookie(this.env.auth.cookie.name, {
      path,
      secure,
      sameSite,
    });
  }
}