import { randomBytes } from "node:crypto";

import { ccc } from "@ckb-ccc/ccc";

import type { AuthRepository } from "../repositories/index.js";
import type { Env } from "../config/index.js";
import type { PublicUser } from "../types/domain.js";
import { toPublicUser } from "../types/domain.js";
import type {
  AuthVerifyRequest,
  SignatureInput,
} from "../validation/auth.schema.js";
import { AppError, UnauthorizedError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { IssuedSession, SessionService } from "./session.service.js";
import type { UserService } from "./user.service.js";
import type { WalletIdentityService } from "./wallet-identity.service.js";

export interface AuthChallenge {
  message: string;
  expiresAt: string;
}

export interface AuthenticatedSession {
  user: PublicUser;
  session: IssuedSession;
}

/**
 * Signature schemes whose CCC `identity` can be bound to a CKB address.
 *
 * `WalletIdentityService` owns that decision; this service only sequences it.
 */
export class AuthService {
  constructor(
    private readonly auth: AuthRepository,
    private readonly users: UserService,
    private readonly sessions: SessionService,
    private readonly identities: WalletIdentityService,
    private readonly env: Env,
  ) {}

  /**
   * Issues a fresh sign-in challenge for `address`.
   *
   * The message - not the nonce - is what the client receives and signs. The
   * nonce is embedded, so there is no separate value a client could swap while
   * leaving the message intact. The nonce is minted first precisely so the
   * stored copy of the message is canonical from the moment it is written.
   */
  requestChallenge(address: string): AuthChallenge {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.env.auth.nonceTtlMs);
    const nonce = AuthService.createNonceValue();
    const message = this.buildMessage(address, nonce, now, expiresAt);

    this.auth.createNonce({
      walletAddress: address,
      nonce,
      message,
      expiresAt: expiresAt.toISOString(),
      now: now.toISOString(),
    });

    return { message, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Verifies a signature against a stored challenge and opens a session.
   *
   * Order matters and is part of the contract: nothing is trusted from the body
   * until it has been matched against the server's own copy.
   */
  async verify(input: AuthVerifyRequest): Promise<AuthenticatedSession> {
    const stored = this.auth.findNonceByMessage(input.message);

    if (!stored) {
      throw new UnauthorizedError(
        "Sign-in request is unknown or already used. Please try again.",
      );
    }
    if (stored.usedAt) {
      throw new UnauthorizedError(
        "Sign-in request has already been used. Please try again.",
      );
    }
    if (Date.parse(stored.expiresAt) <= Date.now()) {
      this.auth.deleteNonce(stored.id);
      throw new UnauthorizedError(
        "Sign-in request has expired. Please try again.",
      );
    }
    if (stored.walletAddress !== input.address) {
      throw new UnauthorizedError(
        "Wallet signature could not be verified. Please try again.",
      );
    }

    // Cheapest first: proving the signature is local, whereas binding a JoyID
    // identity to an address costs a network round trip. Nothing reaches the
    // network until the signature itself is known to be good.
    await this.assertSignatureValid(input.message, input.signature);
    await this.identities.assertBoundToAddress(input.signature, input.address);

    // Single-use: only one of two concurrent verifications can win this.
    if (!this.auth.consumeNonce(stored.id)) {
      throw new UnauthorizedError(
        "Sign-in request has already been used. Please try again.",
      );
    }

    const user = this.users.touchLastLogin(
      this.users.findOrCreateByWalletAddress(input.address).id,
    );
    if (!user) {
      throw new AppError(500, "INTERNAL_ERROR", "Could not create the user");
    }

    return {
      user: toPublicUser(user),
      session: this.sessions.issue(user.id),
    };
  }

  /**
   * The canonical challenge text.
   *
   * The trailing line matters to the user more than to the code: it says out
   * loud that signing this grants no on-chain authority, so an approval prompt
   * cannot be mistaken for a transaction.
   */
  buildMessage(
    address: string,
    nonce: string,
    issuedAt: Date,
    expiresAt: Date,
  ): string {
    const app = this.env.auth.appName;

    return [
      app,
      "",
      `Sign in to ${app}.`,
      "",
      "Address:",
      address,
      "",
      "Nonce:",
      nonce,
      "",
      "Issued At:",
      issuedAt.toISOString(),
      "",
      "Expiration:",
      expiresAt.toISOString(),
      "",
      "This signature does not authorize any blockchain transaction.",
    ].join("\n");
  }

  static createNonceValue(): string {
    // 128 bits of entropy: enough that guessing one is not a strategy, short
    // enough that the value stays legible inside the signed message.
    return randomBytes(16).toString("hex");
  }

  /**
   * Delegates the cryptography to CCC so that every scheme the wallet
   * integrations support is accepted without this service reimplementing any
   * of it. A thrown error (a malformed JoyID payload, an unreachable
   * aggregator) is an invalid signature as far as the API is concerned.
   */
  private async assertSignatureValid(
    message: string,
    signature: SignatureInput,
  ): Promise<void> {
    let valid: boolean;

    try {
      valid = await ccc.Signer.verifyMessage(
        message,
        new ccc.Signature(
          signature.signature,
          signature.identity,
          signature.signType as ccc.SignerSignType,
        ),
      );
    } catch (error) {
      logger.debug("Wallet signature verification threw", {
        signType: signature.signType,
        message: error instanceof Error ? error.message : String(error),
      });
      valid = false;
    }

    if (!valid) {
      throw new UnauthorizedError(
        "Wallet signature could not be verified. Please try again.",
      );
    }
  }
}