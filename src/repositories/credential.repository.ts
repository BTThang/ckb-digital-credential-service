import { randomUUID } from "node:crypto";

import type { AppDatabase } from "../db/database.js";
import {
  CREDENTIAL_COLUMNS,
  toCredentialRecord,
  type CredentialRow,
} from "../models/index.js";
import type { CredentialRecord } from "../types/domain.js";
import type {
  CreateCredentialInput,
  ListCredentialsQuery,
  UpdateCredentialInput,
} from "../validation/credential.schema.js";

const SELECT = `SELECT ${CREDENTIAL_COLUMNS} FROM credentials`;

/**
 * Data access for the credential index.
 *
 * This table is a searchable cache: it exists so the UI can list and filter
 * credentials. It is never consulted to answer "who owns this credential?".
 */
export class CredentialRepository {
  constructor(private readonly db: AppDatabase) {}

  findById(id: string): CredentialRecord | null {
    const row = this.db.raw
      .prepare<[string], CredentialRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row ? toCredentialRecord(row) : null;
  }

  /** Spore ids are hex, so callers may paste them in any case. */
  findBySporeId(sporeId: string): CredentialRecord | null {
    const row = this.db.raw
      .prepare<[string], CredentialRow>(`${SELECT} WHERE spore_id = ?`)
      .get(sporeId.trim().toLowerCase());
    return row ? toCredentialRecord(row) : null;
  }

  findByCreationTxHash(txHash: string): CredentialRecord | null {
    const row = this.db.raw
      .prepare<[string], CredentialRow>(`${SELECT} WHERE creation_tx_hash = ?`)
      .get(txHash.trim().toLowerCase());
    return row ? toCredentialRecord(row) : null;
  }

  list(query: ListCredentialsQuery): { data: CredentialRecord[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (query.owner) {
      where.push("owner_address = ?");
      params.push(query.owner);
    }
    if (query.recipient) {
      where.push("recipient_address = ?");
      params.push(query.recipient);
    }
    if (query.issuer) {
      where.push("issuer_address = ?");
      params.push(query.issuer);
    }
    if (query.issuerName) {
      where.push("issuer_name = ?");
      params.push(query.issuerName);
    }
    if (query.status) {
      where.push("status = ?");
      params.push(query.status);
    }
    if (query.type) {
      where.push("credential_type = ?");
      params.push(query.type);
    }
    if (query.search) {
      where.push("(title LIKE ? OR description LIKE ? OR issuer_name LIKE ?)");
      const like = `%${query.search}%`;
      params.push(like, like, like);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const { total } =
      this.db.raw
        .prepare<Array<string | number>, { total: number }>(
          `SELECT COUNT(*) AS total FROM credentials ${clause}`,
        )
        .get(...params) ?? { total: 0 };

    const rows = this.db.raw
      .prepare<Array<string | number>, CredentialRow>(
        `${SELECT} ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, query.limit, query.offset);

    return { data: rows.map(toCredentialRecord), total };
  }

  findAllByStatus(status: CredentialRecord["status"]): CredentialRecord[] {
    return this.db.raw
      .prepare<[string], CredentialRow>(
        `${SELECT} WHERE status = ? ORDER BY updated_at ASC`,
      )
      .all(status)
      .map(toCredentialRecord);
  }

  findAll(): CredentialRecord[] {
    return this.db.raw
      .prepare<[], CredentialRow>(`${SELECT} ORDER BY created_at ASC`)
      .all()
      .map(toCredentialRecord);
  }

  create(input: CreateCredentialInput): CredentialRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const sporeId = input.sporeId.toLowerCase();

    this.db.raw
      .prepare(
        `INSERT INTO credentials (
           id, spore_id, title, description, issuer_name, issuer_type,
           issuer_address, recipient_address, owner_address, credential_type,
           issue_date, expiration_date, creation_tx_hash, status, network,
           created_at, updated_at
         ) VALUES (
           @id, @spore_id, @title, @description, @issuer_name, @issuer_type,
           @issuer_address, @recipient_address, @owner_address, @credential_type,
           @issue_date, @expiration_date, @creation_tx_hash, @status, @network,
           @created_at, @updated_at
         )`,
      )
      .run({
        id,
        spore_id: sporeId,
        title: input.title,
        description: input.description,
        issuer_name: input.issuerName,
        issuer_type: input.issuerType,
        issuer_address: input.issuerAddress,
        recipient_address: input.recipientAddress,
        // The recipient owns the Spore until the chain says otherwise.
        owner_address: input.recipientAddress,
        credential_type: input.credentialType,
        issue_date: input.issueDate,
        expiration_date: input.expirationDate ?? null,
        creation_tx_hash: input.creationTxHash.toLowerCase(),
        status: "pending",
        network: input.network,
        created_at: now,
        updated_at: now,
      });

    return this.findById(id)!;
  }

  update(
    id: string,
    patch: UpdateCredentialInput,
  ): CredentialRecord | null {
    const columns: Record<string, string | null> = {
      title: patch.title ?? null,
      description: patch.description ?? null,
      issuer_name: patch.issuerName ?? null,
      issuer_type: patch.issuerType ?? null,
      credential_type: patch.credentialType ?? null,
      issue_date: patch.issueDate ?? null,
    };

    const assignments: string[] = [];
    const params: Record<string, string | null> = { id, updated_at: new Date().toISOString() };

    for (const [column, value] of Object.entries(columns)) {
      if (value !== null) {
        assignments.push(`${column} = @${column}`);
        params[column] = value;
      }
    }

    if (patch.expirationDate !== undefined) {
      assignments.push("expiration_date = @expiration_date");
      params.expiration_date = patch.expirationDate ?? null;
    }

    if (assignments.length === 0) return this.findById(id);

    this.db.raw
      .prepare(
        `UPDATE credentials SET ${assignments.join(", ")} WHERE id = @id`,
      )
      .run(params);

    return this.findById(id);
  }

  /**
   * Applies the state read back from the CKB node.
   * Only ever called by the sync/verification services, never by a request
   * body, so a caller can never mark a credential "active" by itself.
   */
  applyChainState(
    id: string,
    state: {
      status: CredentialRecord["status"];
      ownerAddress?: string | null;
    },
  ): CredentialRecord | null {
    this.db.raw
      .prepare(
        `UPDATE credentials
            SET status = @status,
                owner_address = COALESCE(@owner_address, owner_address),
                updated_at = @updated_at
          WHERE id = @id`,
      )
      .run({
        id,
        status: state.status,
        owner_address: state.ownerAddress ?? null,
        updated_at: new Date().toISOString(),
      });

    return this.findById(id);
  }

  delete(id: string): boolean {
    const result = this.db.raw
      .prepare("DELETE FROM credentials WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }
}
