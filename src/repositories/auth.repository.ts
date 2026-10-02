import type { AppDatabase } from "../db/database.js";
import {
  AUTH_NONCE_COLUMNS,
  SESSION_COLUMNS,
  toAuthNonceRecord,
  toSessionRecord,
  type AuthNonceRow,
  type SessionRow,
} from "../models/index.js";
import type { AuthNonceRecord, SessionRecord } from "../types/domain.js";

const SELECT_NONCE = `SELECT ${AUTH_NONCE_COLUMNS} FROM auth_nonces`;
const SELECT_SESSION = `SELECT ${SESSION_COLUMNS} FROM sessions`;

/**
 * Sign-in challenges and sessions.
 *
 * Both tables hold hashes, never usable secrets: `auth_nonces.nonce` is only
 * meaningful inside the message it was generated with, and `session_hash` is a
 * SHA-256 digest of the cookie token. A copy of this database therefore cannot
 * be replayed to impersonate anyone.
 */
export class AuthRepository {
  constructor(private readonly db: AppDatabase) {}

  createNonce(input: {
    walletAddress: string;
    nonce: string;
    message: string;
    expiresAt: string;
    now?: string;
  }): AuthNonceRecord {
    const now = input.now ?? new Date().toISOString();

    this.db.raw
      .prepare(
        `INSERT INTO auth_nonces (
           wallet_address, nonce, message, expires_at, used_at, created_at
         ) VALUES (
           @wallet_address, @nonce, @message, @expires_at, NULL, @created_at
         )`,
      )
      .run({
        wallet_address: input.walletAddress,
        nonce: input.nonce,
        message: input.message,
        expires_at: input.expiresAt,
        created_at: now,
      });

    return this.findNonceByValue(input.nonce)!;
  }

  findNonceByValue(nonce: string): AuthNonceRecord | null {
    const row = this.db.raw
      .prepare<[string], AuthNonceRow>(`${SELECT_NONCE} WHERE nonce = ?`)
      .get(nonce);
    return row ? toAuthNonceRecord(row) : null;
  }

  /**
   * Looks a challenge up by its exact text.
   *
   * The message is the unit of verification - the signature covers these bytes
   * and nothing else - so looking it up verbatim is what makes "the client may
   * not modify the challenge" enforceable rather than aspirational.
   */
  findNonceByMessage(message: string): AuthNonceRecord | null {
    const row = this.db.raw
      .prepare<[string], AuthNonceRow>(`${SELECT_NONCE} WHERE message = ?`)
      .get(message);
    return row ? toAuthNonceRecord(row) : null;
  }

  deleteNonce(id: number): void {
    this.db.raw.prepare("DELETE FROM auth_nonces WHERE id = ?").run(id);
  }

  /**
   * Marks a nonce as spent.
   *
   * The `used_at IS NULL` guard is what makes a nonce single-use under
   * concurrency: the loser of two parallel verifications changes zero rows and
   * is rejected, rather than both being accepted.
   */
  consumeNonce(id: number, at = new Date().toISOString()): boolean {
    const result = this.db.raw
      .prepare("UPDATE auth_nonces SET used_at = @at WHERE id = @id AND used_at IS NULL")
      .run({ id, at });
    return result.changes > 0;
  }

  deleteExpiredNonces(before = new Date().toISOString()): number {
    return this.db.raw
      .prepare("DELETE FROM auth_nonces WHERE expires_at < @before")
      .run({ before }).changes;
  }

  createSession(input: {
    userId: number;
    sessionHash: string;
    expiresAt: string;
    now?: string;
  }): SessionRecord {
    const now = input.now ?? new Date().toISOString();

    this.db.raw
      .prepare(
        `INSERT INTO sessions (
           session_hash, user_id, expires_at, created_at, last_seen_at
         ) VALUES (
           @session_hash, @user_id, @expires_at, @created_at, @created_at
         )`,
      )
      .run({
        session_hash: input.sessionHash,
        user_id: input.userId,
        expires_at: input.expiresAt,
        created_at: now,
      });

    return this.findSessionByHash(input.sessionHash)!;
  }

  findSessionByHash(sessionHash: string): SessionRecord | null {
    const row = this.db.raw
      .prepare<[string], SessionRow>(`${SELECT_SESSION} WHERE session_hash = ?`)
      .get(sessionHash);
    return row ? toSessionRecord(row) : null;
  }

  /**
   * Records activity, at most once per `minIntervalMs`.
   *
   * Without the interval guard every authenticated request would write a row,
   * turning a read-only page into a write storm against the WAL.
   */
  touchSession(
    id: number,
    now = new Date().toISOString(),
    minIntervalMs = 60_000,
  ): void {
    const threshold = new Date(
      Date.parse(now) - minIntervalMs,
    ).toISOString();

    this.db.raw
      .prepare(
        `UPDATE sessions SET last_seen_at = @now
          WHERE id = @id AND (last_seen_at IS NULL OR last_seen_at < @threshold)`,
      )
      .run({ id, now, threshold });
  }

  deleteSessionByHash(sessionHash: string): boolean {
    const result = this.db.raw
      .prepare("DELETE FROM sessions WHERE session_hash = ?")
      .run(sessionHash);
    return result.changes > 0;
  }

  /** Revokes every session of a user - used when the wallet is disconnected. */
  deleteSessionsByUserId(userId: number): number {
    return this.db.raw
      .prepare("DELETE FROM sessions WHERE user_id = ?")
      .run(userId).changes;
  }

  deleteExpiredSessions(before = new Date().toISOString()): number {
    return this.db.raw
      .prepare("DELETE FROM sessions WHERE expires_at < @before")
      .run({ before }).changes;
  }
}