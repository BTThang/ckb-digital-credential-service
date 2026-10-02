import { z } from "zod";

import { ORGANIZATION_TYPES } from "../types/domain.js";
import type { OrganizationType } from "../types/domain.js";
import { ckbAddressSchema } from "./credential.schema.js";

/**
 * A sign-in challenge returned by `POST /api/auth/nonce`.
 *
 * The nonce itself is never a separate field: it is embedded in `message`, so
 * there is nothing for a client to swap out without invalidating the signature.
 */
export const authNonceRequestSchema = z
  .object({
    address: ckbAddressSchema,
  })
  .strict();

export type AuthNonceRequest = z.infer<typeof authNonceRequestSchema>;

/**
 * Signature schemes accepted for sign-in.
 *
 * This is deliberately narrower than CCC's `SignerSignType`. A signature only
 * authenticates an address if the public key behind it can be tied to that
 * address:
 *
 *  - `CkbSecp256k1` hands back the compressed public key, and the CKB address
 *    is `Secp256k1Blake160(hash160(publicKey))` - derivable offline.
 *  - `JoyId` hands back `{keyType, publicKey}` and the JoyID credential server
 *    is the authority that maps that key to a CKB address.
 *
 * `EvmPersonal`, `BtcEcdsa`, `DogeEcdsa` and `NostrEvent` sign with non-CKB
 * keys, so nothing binds them to a CKB address. Accepting them would let anyone
 * sign in as any address by pointing one of their own keys at it.
 *
 * `Unknown` is excluded too: `ccc.Signer.verifyMessage` throws for it instead
 * of returning `false`, which would turn a malformed request into a 500
 * instead of a clean 400.
 */
export const SIGNATURE_SIGN_TYPES = ["CkbSecp256k1", "JoyId"] as const;

/**
 * `ccc.Signature`, as it survives `JSON.stringify`.
 *
 * `message` is deliberately NOT trimmed: the signature covers the exact bytes
 * of the canonical message, so normalising whitespace here would make every
 * valid signature fail to verify.
 */
export const signatureSchema = z
  .object({
    signature: z
      .string()
      .min(2, "signature is required")
      .max(8_192, "signature is too large"),
    identity: z
      .string()
      .min(2, "identity is required")
      .max(1_024, "identity is too large"),
    signType: z.enum(SIGNATURE_SIGN_TYPES),
  })
  .strict();

export type SignatureInput = z.infer<typeof signatureSchema>;

export const authVerifyRequestSchema = z
  .object({
    address: ckbAddressSchema,
    message: z
      .string()
      .min(1, "message is required")
      .max(4_096, "message is too large"),
    signature: signatureSchema,
  })
  .strict();

export type AuthVerifyRequest = z.infer<typeof authVerifyRequestSchema>;

/**
 * Free-text profile field.
 *
 * Three states are kept distinct, because `PATCH` needs all three:
 * `undefined` (key absent, leave the column alone), `null` (key present and
 * cleared) and a string. An empty string is normalised to `null` so clearing a
 * field can be expressed as `""` from a plain form input.
 */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) =>
      value === undefined ? undefined : value === null || value === ""
        ? null
        : value,
    );
}

/**
 * `PATCH /api/profile`.
 *
 * `.strict()` is the authorisation boundary: `userId`, `walletAddress`, `id`
 * and `createdAt` are rejected rather than silently dropped, so a client
 * attempting to edit someone else's row gets a 400 instead of quietly editing
 * its own.
 */
export const updateProfileSchema = z
  .object({
    displayName: optionalText(80),
    avatarUrl: optionalText(2_048).refine(
      (value) => value === null || value === undefined || isHttpUrl(value),
      { message: "avatarUrl must be an http(s) URL" },
    ),
    bio: optionalText(500),
    organizationName: optionalText(120),
    organizationType: z
      .enum(ORGANIZATION_TYPES)
      .or(z.literal(""))
      .nullish()
      .transform((value): OrganizationType | null | undefined =>
        value === undefined ? undefined : value === null || value === "" ? null : value,
      ),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    { message: "Provide at least one profile field to update" },
  );

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Runtime guard used when re-hydrating a row coming from SQLite.
 *
 * A value this build does not recognise (an older or hand-edited database)
 * becomes `other` rather than a type the API claims is valid.
 */
export function toOrganizationType(value: string | null): OrganizationType | null {
  if (value === null) return null;
  return (ORGANIZATION_TYPES as readonly string[]).includes(value)
    ? (value as OrganizationType)
    : "other";
}