import { randomUUID } from "node:crypto";

import type { AppDatabase } from "../db/database.js";
import {
  TRANSACTION_COLUMNS,
  toTransactionRecord,
  type TransactionRow,
} from "../models/index.js";
import type { TransactionRecord, TransactionStatus } from "../types/domain.js";
import { CkbTransactionService } from "../services/ckb/transaction.service.js";
import { logger } from "../utils/logger.js";
import type { UpsertTransactionInput } from "../validation/credential.schema.js";

const SELECT = `SELECT ${TRANSACTION_COLUMNS} FROM transactions`;

/**
 * Transaction tracking cache.
 *
 * `tx_hash` is UNIQUE which is what prevents the same transaction from being
 * recorded twice when a user retries a broadcast.
 */
export class TransactionRepository {
  constructor(private readonly db: AppDatabase) {}

  findByTxHash(txHash: string): TransactionRecord | null {
    const row = this.db.raw
      .prepare<[string], TransactionRow>(`${SELECT} WHERE tx_hash = ?`)
      .get(txHash.toLowerCase());
    return row ? toTransactionRecord(row) : null;
  }

  list(limit = 50, offset = 0): { data: TransactionRecord[]; total: number } {
    const { total } =
      this.db.raw
        .prepare<[], { total: number }>(
          "SELECT COUNT(*) AS total FROM transactions",
        )
        .get() ?? { total: 0 };

    const rows = this.db.raw
      .prepare<[number, number], TransactionRow>(
        `${SELECT} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);

    return { data: rows.map(toTransactionRecord), total };
  }

  listByStatus(status: TransactionStatus): TransactionRecord[] {
    return this.db.raw
      .prepare<[string], TransactionRow>(
        `${SELECT} WHERE status = ? ORDER BY created_at ASC`,
      )
      .all(status)
      .map(toTransactionRecord);
  }

  /**
   * The lifecycle history of one credential, oldest first.
   *
   * Every write records the Spore id, and the id survives transfers and melts,
   * so filtering on it reconstructs the whole issue/transfer/melt sequence —
   * unlike the owner, which only ever shows the latest holder.
   */
  listBySporeId(sporeId: string, limit = 50): TransactionRecord[] {
    return this.db.raw
      .prepare<[string, number], TransactionRow>(
        `${SELECT} WHERE spore_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(sporeId.toLowerCase(), limit)
      .map(toTransactionRecord);
  }

  /** Idempotent upsert keyed on `tx_hash`. */
  upsert(input: UpsertTransactionInput): TransactionRecord {
    const txHash = input.txHash.toLowerCase();
    const now = new Date().toISOString();
    const existing = this.findByTxHash(txHash);

    if (existing) {
      this.db.raw
        .prepare(
          `UPDATE transactions
              SET credential_id = COALESCE(@credential_id, credential_id),
                  spore_id      = COALESCE(@spore_id, spore_id),
                  type          = @type,
                  status        = @status,
                  block_number  = COALESCE(@block_number, block_number),
                  detail        = COALESCE(@detail, detail),
                  updated_at    = @updated_at
            WHERE tx_hash = @tx_hash`,
        )
        .run({
          tx_hash: txHash,
          credential_id: input.credentialId ?? null,
          spore_id: input.sporeId ?? null,
          type: input.type,
          status: input.status,
          block_number: input.blockNumber ?? null,
          detail: input.detail ?? null,
          updated_at: now,
        });

      return this.findByTxHash(txHash)!;
    }

    const id = randomUUID();
    this.db.raw
      .prepare(
        `INSERT INTO transactions (
           id, tx_hash, credential_id, spore_id, type, status,
           block_number, detail, created_at, updated_at
         ) VALUES (
           @id, @tx_hash, @credential_id, @spore_id, @type, @status,
           @block_number, @detail, @created_at, @updated_at
         )`,
      )
      .run({
        id,
        tx_hash: txHash,
        credential_id: input.credentialId ?? null,
        spore_id: input.sporeId ?? null,
        type: input.type,
        status: input.status,
        block_number: input.blockNumber ?? null,
        detail: input.detail ?? null,
        created_at: now,
        updated_at: now,
      });

    return this.findByTxHash(txHash)!;
  }

  updateStatus(
    txHash: string,
    status: TransactionStatus,
    blockNumber?: string | null,
  ): TransactionRecord | null {
    this.db.raw
      .prepare(
        `UPDATE transactions
            SET status = @status,
                block_number = COALESCE(@block_number, block_number),
                updated_at = @updated_at
          WHERE tx_hash = @tx_hash`,
      )
      .run({
        tx_hash: txHash.toLowerCase(),
        status,
        block_number: blockNumber ?? null,
        updated_at: new Date().toISOString(),
      });

    return this.findByTxHash(txHash);
  }

  deleteByCredential(credentialId: string): void {
    this.db.raw
      .prepare("DELETE FROM transactions WHERE credential_id = ?")
      .run(credentialId);
  }

  /**
   * Reconciles every still-unfinished transaction with the chain.
   *
   * Bounded on purpose: the loop visits each row exactly once, the node call is
   * sequential and failures are logged and skipped, so a flaky RPC can never
   * turn this into an unbounded retry loop.
   */
  async reconcile(ckb: CkbTransactionService): Promise<number> {
    return this.reconcileRecords(
      [
        ...this.listByStatus("submitted"),
        ...this.listByStatus("pending"),
      ],
      ckb,
    );
  }

  /**
   * Reconciles only one credential's unfinished writes.
   *
   * The client only calls `/sync` once, right after broadcasting, when the
   * transaction is usually still unconfirmed — so without this the row would
   * stay `submitted`/`pending` forever. The lifecycle view calls it on read so
   * the history reflects the chain the moment the page is opened.
   */
  async reconcileBySporeId(
    sporeId: string,
    ckb: CkbTransactionService,
  ): Promise<number> {
    const pending = this.listBySporeId(sporeId, 100).filter(
      (record) => record.status === "submitted" || record.status === "pending",
    );
    return this.reconcileRecords(pending, ckb);
  }

  private async reconcileRecords(
    records: TransactionRecord[],
    ckb: CkbTransactionService,
  ): Promise<number> {
    let updated = 0;

    for (const record of records) {
      try {
        const chain = await ckb.getTransaction(record.txHash);
        if (chain.error) {
          logger.warn(
            `Skipping reconcile of ${record.txHash}: ${chain.error}`,
          );
          continue;
        }

        const nextStatus = CkbTransactionService.toApplicationStatus(
          chain.status,
        );

        if (nextStatus !== record.status || chain.blockNumber) {
          this.updateStatus(record.txHash, nextStatus, chain.blockNumber);
          updated += 1;
        }
      } catch (error) {
        logger.warn(
          `Unexpected failure while reconciling ${record.txHash}`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return updated;
  }
}
