import type {
  AuthNonceRecord,
  SessionRecord,
  UserRecord,
} from "../types/domain.js";
import { toOrganizationType } from "../validation/auth.schema.js";

/**
 * One row of the `users` table, exactly as SQLite hands it back.
 *
 * Every column is TEXT except the surrogate key. The wallet address is stored
 * as sent - CKB addresses are case-insensitive bech32, but the unique index is
 * on the verbatim string, so callers normalise before writing.
 */
export interface UserRow {
  id: number;
  wallet_address: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  organization_name: string | null;
  organization_type: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

/** Must list exactly the fields of {@link UserRow}. */
export const USER_COLUMNS = `
  id, wallet_address, display_name, avatar_url, bio,
  organization_name, organization_type,
  created_at, updated_at, last_login_at
`;

export function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    organizationName: row.organization_name,
    organizationType: toOrganizationType(row.organization_type),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

/** One row of `auth_nonces` - a pending sign-in challenge. */
export interface AuthNonceRow {
  id: number;
  wallet_address: string;
  nonce: string;
  message: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

/** Must list exactly the fields of {@link AuthNonceRow}. */
export const AUTH_NONCE_COLUMNS = `
  id, wallet_address, nonce, message, expires_at, used_at, created_at
`;

export function toAuthNonceRecord(row: AuthNonceRow): AuthNonceRecord {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    nonce: row.nonce,
    message: row.message,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

/** One row of `sessions`. `session_hash` is a SHA-256 digest, never a token. */
export interface SessionRow {
  id: number;
  session_hash: string;
  user_id: number;
  expires_at: string;
  created_at: string;
  last_seen_at: string | null;
}

/** Must list exactly the fields of {@link SessionRow}. */
export const SESSION_COLUMNS = `
  id, session_hash, user_id, expires_at, created_at, last_seen_at
`;

export function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    sessionHash: row.session_hash,
    userId: row.user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}