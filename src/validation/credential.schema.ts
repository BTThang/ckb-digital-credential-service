import { z } from "zod";

import {
  CREDENTIAL_STATUSES,
  CREDENTIAL_TYPES,
  ISSUER_TYPES,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  type CredentialStatus,
  type CredentialRecord,
  type CredentialType,
  type IssuerType,
  type TransactionStatus,
  type TransactionType,
} from "../types/domain.js";

export const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * A CKB address must be a bech32m string. This is only a cheap pre-filter;
 * the authoritative check is `ccc.Address.fromString(..., client)` which also
 * enforces the network's `ckb1`/`ckt1` prefix and the bech32m checksum.
 */
export const ckbAddressSchema = z
  .string()
  .trim()
  .min(8, "CKB address is required")
  .max(128, "CKB address is too long")
  .regex(
    /^(ckb|ckt)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}$/,
    "Invalid CKB address (expected a bech32m address starting with ckb1... or ckt1...)",
  );

export const hex32Schema = z
  .string()
  .trim()
  .regex(HEX_32, "Expected a 0x-prefixed 32-byte hex value");

/**
 * A Spore v2 id is a bare 32-byte value: the cell's *type script args*, which
 * `@ckb-ccc/spore` fills with `hashTypeId(firstInput, outputIndex)` and returns
 * from `createSpore`. It is deliberately NOT the cell outpoint, so the usual
 * `0x<txHash>0x<index>` shape is rejected rather than silently accepted.
 */
export const SPORE_ID = /^0x[0-9a-fA-F]{64}$/;

export const sporeIdSchema = z
  .string()
  .trim()
  .regex(SPORE_ID, "Expected a Spore id: 0x followed by 64 hex characters");

export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date formatted as YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    message: "Invalid calendar date",
  });

export const createCredentialSchema = z
  .object({
    sporeId: sporeIdSchema,
    title: z.string().trim().min(3, "Title must be at least 3 characters").max(120),
    description: z.string().trim().max(1_000).default(""),
    issuerName: z
      .string()
      .trim()
      .min(2, "Issuer name must be at least 2 characters")
      .max(120),
    issuerType: z.enum(ISSUER_TYPES).default("OTHER"),
    issuerAddress: ckbAddressSchema,
    recipientAddress: ckbAddressSchema,
    credentialType: z.enum(CREDENTIAL_TYPES),
    issueDate: isoDateSchema,
    expirationDate: isoDateSchema.nullish(),
    creationTxHash: hex32Schema,
    network: z.string().trim().min(2).max(32).default("testnet"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expirationDate && value.expirationDate < value.issueDate) {
      ctx.addIssue({
        code: "custom",
        path: ["expirationDate"],
        message: "Expiration date must be on or after the issue date",
      });
    }
  });

export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;

export const updateCredentialSchema = z
  .object({
    title: z.string().trim().min(3).max(120).optional(),
    description: z.string().trim().max(1_000).optional(),
    issuerName: z.string().trim().min(2).max(120).optional(),
    issuerType: z.enum(ISSUER_TYPES).optional(),
    credentialType: z.enum(CREDENTIAL_TYPES).optional(),
    issueDate: isoDateSchema.optional(),
    expirationDate: isoDateSchema.nullish(),
  })
  .strict();

export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;

export const listCredentialsQuerySchema = z
  .object({
    owner: ckbAddressSchema.optional(),
    recipient: ckbAddressSchema.optional(),
    issuer: ckbAddressSchema.optional(),
    issuerName: z.string().trim().min(1).max(120).optional(),
    status: z.enum(CREDENTIAL_STATUSES).optional(),
    type: z.enum(CREDENTIAL_TYPES).optional(),
    search: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type ListCredentialsQuery = z.infer<typeof listCredentialsQuerySchema>;

export const idParamSchema = z
  .object({ id: z.string().trim().min(1).max(64) })
  .strict();

export const sporeIdParamSchema = z
  .object({ sporeId: sporeIdSchema })
  .strict();

/**
 * `GET /api/verify/:credentialId`. The public credential id *is* the Spore id,
 * so it validates against the same rule under its public name rather than
 * inventing a second id format.
 */
export const credentialIdParamSchema = z
  .object({ credentialId: sporeIdSchema })
  .strict();

export const txHashParamSchema = z
  .object({ txHash: hex32Schema })
  .strict();

export const upsertTransactionSchema = z
  .object({
    txHash: hex32Schema,
    credentialId: z.string().trim().min(1).max(64).nullish(),
    sporeId: sporeIdSchema.nullish(),
    type: z.enum([
      "CREATE_CREDENTIAL",
      "TRANSFER_CREDENTIAL",
      "MELT_CREDENTIAL",
    ]),
    status: z.enum(["submitted", "pending", "committed", "failed"]),
    blockNumber: z
      .string()
      .trim()
      .regex(/^\d+$/, "blockNumber must be a numeric string")
      .nullish(),
    detail: z.string().trim().max(280).nullish(),
  })
  .strict();

export type UpsertTransactionInput = z.infer<typeof upsertTransactionSchema>;

/** Runtime guard used when re-hydrating a row coming from SQLite. */
export function toCredentialType(value: string): CredentialType {
  return (CREDENTIAL_TYPES as readonly string[]).includes(value)
    ? (value as CredentialType)
    : "OTHER";
}

export function toIssuerType(value: string): IssuerType {
  return (ISSUER_TYPES as readonly string[]).includes(value)
    ? (value as IssuerType)
    : "OTHER";
}

export function toCredentialStatus(value: string): CredentialStatus {
  return (CREDENTIAL_STATUSES as readonly string[]).includes(value)
    ? (value as CredentialStatus)
    : "unknown";
}

export function toTransactionType(value: string): TransactionType {
  return (TRANSACTION_TYPES as readonly string[]).includes(value)
    ? (value as TransactionType)
    : "CREATE_CREDENTIAL";
}

export function toTransactionStatus(value: string): TransactionStatus {
  return (TRANSACTION_STATUSES as readonly string[]).includes(value)
    ? (value as TransactionStatus)
    : "pending";
}

export type { CredentialRecord };
