import type { NextFunction, Request, Response } from "express";

import type { Repositories } from "../repositories/index.js";
import { CkbTransactionService } from "../services/ckb/transaction.service.js";
import {
  CkbUnavailableError,
  NotFoundError,
} from "../utils/errors.js";
import type { UpsertTransactionInput } from "../validation/credential.schema.js";

export interface TransactionControllerDeps {
  repositories: Repositories;
  ckbTransactions: CkbTransactionService;
}

export function transactionController(deps: TransactionControllerDeps) {
  const { repositories, ckbTransactions } = deps;

  return {
    /**
     * `GET /api/transactions/:txHash`
     *
     * Merges the local tracking row with the authoritative chain state so the
     * Transactions page can render a status it can trust.
     */
    async get(req: Request, res: Response, next: NextFunction): Promise<void> {
      const { txHash } = req.params as { txHash: string };
      const normalized = txHash.toLowerCase();
      const chain = await ckbTransactions.getTransaction(normalized);
      const indexed = repositories.transactions.findByTxHash(normalized);

      if (chain.error) {
        // The node is unreachable: this is explicitly *not* "transaction failed".
        next(new CkbUnavailableError("The CKB RPC node is currently unavailable", chain.error));
        return;
      }

      if (!chain.found && indexed === null) {
        throw new NotFoundError(`Transaction "${normalized}" is unknown to the CKB network`);
      }

      const status = chain.found
        ? CkbTransactionService.toApplicationStatus(chain.status)
        : (indexed?.status ?? "pending");

      res.json({
        data: {
          txHash: normalized,
          // Chain is authoritative; the cached row is only a hint.
          status,
          found: chain.found,
          chain,
          indexed: indexed
            ? {
                id: indexed.id,
                type: indexed.type,
                status: indexed.status,
                credentialId: indexed.credentialId,
                sporeId: indexed.sporeId,
                blockNumber: indexed.blockNumber,
                detail: indexed.detail,
                createdAt: indexed.createdAt,
                updatedAt: indexed.updatedAt,
              }
            : null,
          inSync:
            indexed === null ? null : indexed.status === status,
        },
      });
    },

    /** `POST /api/transactions` - idempotent upsert keyed on the tx hash. */
    upsert(req: Request, res: Response, _next: NextFunction): void {
      const input = req.body as UpsertTransactionInput;
      const record = repositories.transactions.upsert(input);

      res.status(201).json({ data: record });
    },

    /** `GET /api/transactions` - paginated tracking list (newest first). */
    async list(req: Request, res: Response, _next: NextFunction): Promise<void> {
      const limit = Number(req.query.limit ?? 25);
      const offset = Number(req.query.offset ?? 0);
      const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 25;
      const safeOffset = Number.isFinite(offset) ? Math.max(offset, 0) : 0;
      const sporeId =
        typeof req.query.sporeId === "string" ? req.query.sporeId : undefined;

      if (sporeId) {
        // A credential's history is shown as chain truth: reconcile the
        // still-unfinished writes first, so "Issued" flips to committed as
        // soon as the cell is live instead of staying on its cached status.
        await repositories.transactions.reconcileBySporeId(
          sporeId,
          ckbTransactions,
        );
        const data = repositories.transactions.listBySporeId(sporeId, safeLimit);
        res.json({
          data,
          meta: { total: data.length, limit: safeLimit, offset: 0 },
        });
        return;
      }

      const result = repositories.transactions.list(safeLimit, safeOffset);
      res.json({
        data: result.data,
        meta: { total: result.total, limit: safeLimit, offset: safeOffset },
      });
    },
  };
}
