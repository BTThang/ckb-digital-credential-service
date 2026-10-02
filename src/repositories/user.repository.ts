import type { AppDatabase } from "../db/database.js";
import {
  USER_COLUMNS,
  toUserRecord,
  type UserRow,
} from "../models/index.js";
import type { UserRecord } from "../types/domain.js";
import type { UpdateProfileInput } from "../validation/auth.schema.js";

const SELECT = `SELECT ${USER_COLUMNS} FROM users`;

/**
 * Application identities.
 *
 * `wallet_address` is UNIQUE, which is what guarantees a second sign-in with
 * the same wallet reuses the same row instead of creating a duplicate. It is
 * the only field a client can influence indirectly, and only ever through a
 * verified signature challenge.
 */
export class UserRepository {
  constructor(private readonly db: AppDatabase) {}

  findById(id: number): UserRecord | null {
    const row = this.db.raw
      .prepare<[number], UserRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row ? toUserRecord(row) : null;
  }

  findByWalletAddress(walletAddress: string): UserRecord | null {
    const row = this.db.raw
      .prepare<[string], UserRow>(`${SELECT} WHERE wallet_address = ?`)
      .get(walletAddress);
    return row ? toUserRecord(row) : null;
  }

  /**
   * Returns the user for `walletAddress`, creating a bare row on first sign-in.
   *
   * The UNIQUE index on `wallet_address` is the real guarantee: if two
   * sign-ins race, one INSERT fails and the caller falls back to the lookup.
   */
  findOrCreateByWalletAddress(
    walletAddress: string,
    now = new Date().toISOString(),
  ): UserRecord {
    const existing = this.findByWalletAddress(walletAddress);
    if (existing) return existing;

    this.db.raw
      .prepare(
        `INSERT INTO users (
           wallet_address, display_name, avatar_url, bio,
           organization_name, organization_type,
           created_at, updated_at, last_login_at
         ) VALUES (
           @wallet_address, NULL, NULL, NULL,
           NULL, NULL,
           @created_at, @updated_at, @last_login_at
         )`,
      )
      .run({
        wallet_address: walletAddress,
        created_at: now,
        updated_at: now,
        last_login_at: now,
      });

    return this.findByWalletAddress(walletAddress)!;
  }

  /** Stamps a successful sign-in. */
  touchLastLogin(id: number, at = new Date().toISOString()): UserRecord | null {
    this.db.raw
      .prepare("UPDATE users SET last_login_at = @at, updated_at = @at WHERE id = @id")
      .run({ id, at });
    return this.findById(id);
  }

  /**
   * Applies a profile patch.
   *
   * Only the keys the client actually sent are written, so a `PATCH` that
   * changes one field leaves the rest alone - and a field sent as `null` is
   * still cleared. Writing every column unconditionally would turn every
   * single-field edit into a request to erase the rest of the profile.
   *
   * The caller resolves `id` from the session, never from the request.
   */
  updateProfile(
    id: number,
    patch: UpdateProfileInput,
  ): UserRecord | null {
    const columns = {
      displayName: "display_name",
      avatarUrl: "avatar_url",
      bio: "bio",
      organizationName: "organization_name",
      organizationType: "organization_type",
    } as const;

    const assignments: string[] = [];
    const values: Record<string, number | string | null> = { id };

    for (const [field, column] of Object.entries(columns)) {
      const value = patch[field as keyof UpdateProfileInput];
      if (value === undefined) continue;
      assignments.push(`${column} = @${column}`);
      values[column] = value;
    }

    assignments.push("updated_at = @updated_at");
    values.updated_at = new Date().toISOString();

    this.db.raw
      .prepare(
        `UPDATE users SET ${assignments.join(", ")} WHERE id = @id`,
      )
      .run(values);

    return this.findById(id);
  }

  count(): number {
    return (
      this.db.raw.prepare<[], { total: number }>(
        "SELECT COUNT(*) AS total FROM users",
      ).get()?.total ?? 0
    );
  }
}