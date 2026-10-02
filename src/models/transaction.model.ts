import type {
  TransactionRecord,
} from "../types/domain.js";
import {
  toTransactionStatus,
  toTransactionType,
} from "../validation/credential.schema.js";

/**
 * One row of the `transactions` table, exactly as SQLite hands it back.
 *
 * See {@link CredentialRow} for why the numeric-looking columns are TEXT.
 */
export interface TransactionRow {
  id: string;
  tx_hash: string;
  credential_id: string | null;
  spore_id: string | null;
  type: string;
  status: string;
  block_number: string | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

/** Must list exactly the fields of {@link TransactionRow}. */
export const TRANSACTION_COLUMNS = `
  id, tx_hash, credential_id, spore_id, type, status,
  block_number, detail, created_at, updated_at
`;

/**
 * Rehydrates a row into a domain record, coercing the enum columns.
 *
 * `credential_id` is nullable because a transaction can be reported before
 * the credential it creates has been indexed; the reconcile pass backfills it
 * via the UNIQUE `tx_hash` upsert.
 */
export function toTransactionRecord(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    txHash: row.tx_hash,
    credentialId: row.credential_id,
    sporeId: row.spore_id,
    type: toTransactionType(row.type),
    status: toTransactionStatus(row.status),
    blockNumber: row.block_number,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
