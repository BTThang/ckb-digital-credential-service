import { ccc } from "@ckb-ccc/ccc";
import { SigningAlg, type CredentialKeyType } from "@joyid/common";
import { verifyCredential } from "@joyid/ckb";

import type { Env } from "../config/index.js";
import type { SignatureInput } from "../validation/auth.schema.js";
import { AppError, UnauthorizedError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Secp256k1Blake160, the lock behind every `CkbSecp256k1` address.
 *
 * Constant across networks, so the derivation below needs no RPC and no
 * script table.
 */
const SECP256K1_BLAKE160_CODE_HASH =
  "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

/** A compressed secp256k1 public key is 33 bytes with a 0x02/0x03 tag byte. */
const COMPRESSED_PUBLIC_KEY_BYTES = 33;

const JOYID_KEY_TYPES: readonly CredentialKeyType[] = [
  "main_key",
  "sub_key",
  "main_session_key",
  "sub_session_key",
];

/**
 * What a CCC JoyID signer reports as its identity.
 *
 * `publicKey` carries no `0x` prefix - that is how `JoyId.CkbSigner`
 * serialises it, and `verifyCredential` compares against the registry using
 * the same convention.
 */
interface JoyIdIdentity {
  keyType: CredentialKeyType;
  publicKey: string;
}

export interface JoyIdCredential {
  pubkey: string;
  address: string;
  keyType: CredentialKeyType;
}

/**
 * Indirection over the JoyID registry lookup.
 *
 * This is the only part of sign-in that touches the network, so it is the only
 * part worth making substitutable. Production uses JoyID's own verifier.
 */
export type JoyIdCredentialVerifier = (
  credential: JoyIdCredential,
  serverUrl: string,
) => Promise<boolean>;

/**
 * Proves that the key which produced a signature is the key behind an address.
 *
 * This is the step that makes sign-in mean anything. A signature on its own
 * proves only that whoever signed holds the key they handed over: without this
 * check, a client could request a challenge for someone else's address, sign
 * it with its own key, and be issued a session for that address. Keeping the
 * address inside the signed message does not help - the attacker chooses which
 * address to name when requesting the challenge.
 *
 * Each supported scheme is bound differently, because the schemes are:
 *
 *  - `CkbSecp256k1`: derived locally, offline, from the compressed public key
 *    the signer already reports. Deterministic and cheap.
 *  - `JoyId`: resolved through the JoyID credential server, because a JoyID
 *    CKB address is not derivable from the key - the JoyID lock's args are
 *    empty, so the mapping only exists in JoyID's registry.
 *
 * Anything that cannot be bound is refused rather than trusted.
 */
export class WalletIdentityService {
  /** Only `addressPrefix` is read, so no RPC client is required. */
  private readonly addressClient: ccc.Client;

  constructor(
    private readonly env: Env,
    private readonly verifyJoyIdCredential: JoyIdCredentialVerifier =
      defaultJoyIdCredentialVerifier,
  ) {
    this.addressClient = {
      addressPrefix: env.network === "mainnet" ? "ckb" : "ckt",
    } as unknown as ccc.Client;
  }

  /**
   * Throws unless `signature.identity` provably belongs to `address`.
   *
   * The failure is always an authentication failure: a caller must not be able
   * to learn whether the key exists, whether the address is known, or why the
   * binding failed.
   */
  async assertBoundToAddress(
    signature: SignatureInput,
    address: string,
  ): Promise<void> {
    const bound =
      signature.signType === "CkbSecp256k1"
        ? this.isSecp256k1Bound(signature.identity, address)
        : await this.isJoyIdBound(signature.identity, address);

    if (!bound) {
      throw new UnauthorizedError(
        "Wallet signature could not be verified. Please try again.",
      );
    }
  }

  /**
   * Recovers the CKB address from the compressed public key and compares it to
   * the claimed address.
   *
   * The address is derived with this deployment's network prefix, so a testnet
   * deployment cannot be signed in to with a mainnet address (or the reverse).
   */
  private isSecp256k1Bound(identity: string, address: string): boolean {
    const publicKey = WalletIdentityService.parseCompressedPublicKey(identity);
    if (!publicKey) return false;

    try {
      const lock = ccc.Script.from({
        codeHash: SECP256K1_BLAKE160_CODE_HASH,
        hashType: "type",
        args: ccc.hashCkbShort(publicKey),
      });

      return (
        ccc.Address.fromScript(lock, this.addressClient).toString().toLowerCase() ===
        address.toLowerCase()
      );
    } catch (error) {
      logger.debug("secp256k1 address derivation failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Asks the JoyID credential server whether the submitted public key is
   * registered for `address`.
   *
   * Fails closed. An unreachable or erroring JoyID server is an unusable
   * sign-in path, never an implicit approval - otherwise a JoyID outage (or a
   * DNS failure) would become an authentication bypass.
   */
  private async isJoyIdBound(
    identity: string,
    address: string,
  ): Promise<boolean> {
    const serverUrl = this.env.auth.joyIdCredentialServerUrl;
    if (!serverUrl) {
      logger.error(
        "JoyID sign-in refused: JOYID_CREDENTIAL_SERVER_URL is not configured",
      );
      throw new AppError(
        503,
        "WALLET_IDENTITY_UNAVAILABLE",
        "This wallet cannot be verified right now. Please try another wallet.",
      );
    }

    const parsed = WalletIdentityService.parseJoyIdIdentity(identity);
    if (!parsed) return false;

    try {
      return await this.verifyJoyIdCredential(
        { pubkey: parsed.publicKey, address, keyType: parsed.keyType },
        serverUrl,
      );
    } catch (error) {
      logger.error("JoyID credential lookup failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Accepts both `0x`-prefixed and bare hex, since wallets differ, but insists
   * on a value that can actually be a compressed secp256k1 key.
   *
   * `ccc.hexFrom` both normalises and rejects non-hex input, so it doubles as
   * the length/format check.
   */
  private static parseCompressedPublicKey(
    identity: string,
  ): `0x${string}` | null {
    const hex = identity.startsWith("0x") ? identity : `0x${identity}`;

    let bytes: Uint8Array;
    try {
      bytes = ccc.bytesFrom(hex);
    } catch {
      return null;
    }

    if (bytes.length !== COMPRESSED_PUBLIC_KEY_BYTES) return null;
    if (bytes[0] !== 0x02 && bytes[0] !== 0x03) return null;

    return ccc.hexFrom(hex);
  }

  private static parseJoyIdIdentity(identity: string): JoyIdIdentity | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(identity);
    } catch {
      return null;
    }

    if (typeof parsed !== "object" || parsed === null) return null;

    const { keyType, publicKey } = parsed as Record<string, unknown>;
    if (
      typeof keyType !== "string" ||
      !JOYID_KEY_TYPES.includes(keyType as CredentialKeyType)
    ) {
      return null;
    }
    if (typeof publicKey !== "string" || publicKey.length === 0) return null;

    return { keyType: keyType as CredentialKeyType, publicKey };
  }
}

/**
 * Asks JoyID's registry whether this key is registered for this address.
 *
 * `SigningAlg.ES256` is passed deliberately. The identity CCC reports has no
 * `0x` prefix, and JoyID stores native keys with one, so the comparison has to
 * take the branch that strips the prefix. Any non-RS256 value does that; the
 * session key types are handled by `keyType` either way.
 */
const defaultJoyIdCredentialVerifier: JoyIdCredentialVerifier = async (
  credential,
  serverUrl,
) =>
  verifyCredential(
    {
      pubkey: credential.pubkey,
      address: credential.address,
      keyType: credential.keyType,
      alg: SigningAlg.ES256,
    },
    serverUrl,
  );
