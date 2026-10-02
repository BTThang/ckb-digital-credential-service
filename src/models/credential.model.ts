import type { CredentialRecord } from "../types/domain.js";
import {
  toCredentialStatus,
  toCredentialType,
  toIssuerType,
} from "../validation/credential.schema.js";

/**
 * One row of the `credentials` table, exactly as SQLite hands it back.
 *
 * Every column is TEXT. CKB block numbers exceed `Number.MAX_SAFE_INTEGER`, so
 * storing them as INTEGER or REAL would silently corrupt large values; they
 * stay strings and are converted only where a consumer really needs a number.
 *
 * The row shape lives here rather than inline in the repository so that it and
 * {@link CREDENTIAL_COLUMNS} - which must agree field for field - are edited
 * together. If they drift, the mapper starts producing `undefined` fields at
 * runtime with no type error to catch it.
 */
export interface CredentialRow {
  id: string;
  spore_id: string;
  title: string;
  description: string;
  issuer_name: string;
  issuer_type: string;
  issuer_address: string;
  recipient_address: string;
  owner_address: string;
  credential_type: string;
  issue_date: string;
  expiration_date: string | null;
  creation_tx_hash: string;
  status: string;
  network: string;
  created_at: string;
  updated_at: string;
}

/** Must list exactly the fields of {@link CredentialRow}. */
export const CREDENTIAL_COLUMNS = `
  id, spore_id, title, description, issuer_name, issuer_type,
  issuer_address, recipient_address, owner_address, credential_type,
  issue_date, expiration_date, creation_tx_hash, status, network,
  created_at, updated_at
`;

/**
 * Rehydrates a row into a domain record.
 *
 * Enum columns are coerced, not cast. SQLite stores them as unconstrained
 * TEXT, so a value this build does not recognise - an older deployment, or a
 * hand-edited database - becomes an explicit `unknown` / `OTHER` fallback
 * rather than being handed to API clients under a type that claims it is a
 * valid value.
 */
export function toCredentialRecord(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    sporeId: row.spore_id,
    title: row.title,
    description: row.description,
    issuerName: row.issuer_name,
    issuerType: toIssuerType(row.issuer_type),
    issuerAddress: row.issuer_address,
    recipientAddress: row.recipient_address,
    ownerAddress: row.owner_address,
    credentialType: toCredentialType(row.credential_type),
    issueDate: row.issue_date,
    expirationDate: row.expiration_date,
    creationTxHash: row.creation_tx_hash,
    status: toCredentialStatus(row.status),
    network: row.network,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
