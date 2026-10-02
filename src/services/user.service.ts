import type { UserRepository } from "../repositories/index.js";
import type { UserRecord } from "../types/domain.js";
import type { UpdateProfileInput } from "../validation/auth.schema.js";
import { NotFoundError } from "../utils/errors.js";

/**
 * Application identity and profile.
 *
 * Nothing here touches the chain: a profile is a self-declared description of
 * who controls a wallet, and the service has no way to prove anything beyond
 * "this wallet signed a challenge once".
 */
export class UserService {
  constructor(private readonly users: UserRepository) {}

  findById(id: number): UserRecord | null {
    return this.users.findById(id);
  }

  findByWalletAddress(walletAddress: string): UserRecord | null {
    return this.users.findByWalletAddress(walletAddress);
  }

  /**
   * First sign-in creates the row, later sign-ins reuse it.
   *
   * `wallet_address` is UNIQUE, so this is idempotent for a given wallet: the
   * E2E checklist's "log in twice, no duplicate user" is enforced by the schema,
   * not by trusting the caller.
   */
  findOrCreateByWalletAddress(walletAddress: string): UserRecord {
    return this.users.findOrCreateByWalletAddress(walletAddress);
  }

  touchLastLogin(id: number): UserRecord | null {
    return this.users.touchLastLogin(id);
  }

  getProfile(id: number): UserRecord {
    const user = this.users.findById(id);
    if (!user) throw new NotFoundError("User not found");
    return user;
  }

  /**
   * Updates the profile of `id` - and only of `id`.
   *
   * `id` is always the one resolved from the session cookie. There is no
   * overload that accepts an id from the request body, so a client cannot edit
   * somebody else's row even by guessing a numeric id.
   */
  updateProfile(id: number, patch: UpdateProfileInput): UserRecord {
    const user = this.users.updateProfile(id, patch);
    if (!user) throw new NotFoundError("User not found");
    return user;
  }
}