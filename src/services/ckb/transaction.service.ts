import { type ccc } from "@ckb-ccc/ccc";

import { CkbUnavailableError, errorMessage } from "../../utils/errors.js";
import type {
  CkbTransactionStatus,
  TransactionChainInfo,
} from "../../types/domain.js";
import type { CkbClientService } from "./client.js";

/**
 * Normalises a CCC transaction status string. Unknown values become `"unknown"`
 * rather than being silently coerced into a success state.
 */
export function toChainStatus(
  value: string | undefined,
): CkbTransactionStatus {
  switch (value) {
    case "sent":
    case "pending":
    case "proposed":
    case "committed":
    case "rejected":
      return value;
    default:
      return "unknown";
  }
}

/**
 * Reads a transaction from the node.
 *
 * `found: false` means the node has never heard of the hash - that is a
 * legitimate "not found" answer. A thrown error means the RPC call itself
 * failed, which is reported separately so callers can answer
 * "unable to verify" instead of "not found".
 */
export class CkbTransactionService {
  constructor(private readonly ckb: CkbClientService) {}

  async getTransaction(txHash: string): Promise<TransactionChainInfo> {
    const base: TransactionChainInfo = {
      txHash,
      found: false,
      status: null,
      blockNumber: null,
      blockHash: null,
      reason: null,
      error: null,
      inputCount: null,
      outputCount: null,
    };

    let response: Awaited<ReturnType<ccc.Client["getTransaction"]>>;
    try {
      response = await this.ckb.client.getTransaction(txHash);
    } catch (error) {
      return {
        ...base,
        error: errorMessage(error),
        reason: "The CKB RPC node could not be queried for this transaction",
      };
    }

    if (!response) {
      return { ...base, reason: "Transaction not found on the CKB network" };
    }

    const status = toChainStatus(response.status);

    return {
      ...base,
      found: true,
      status,
      blockNumber: response.blockNumber?.toString() ?? null,
      blockHash: response.blockHash ?? null,
      inputCount: response.transaction.inputs.length,
      outputCount: response.transaction.outputs.length,
      reason:
        response.reason ??
        (status === "rejected" ? "Transaction was rejected by the node" : null),
    };
  }

  /**
   * Same as {@link getTransaction} but throws {@link CkbUnavailableError} when
   * the node itself is unreachable, so callers can answer 503 instead of 404.
   */
  async requireTransaction(txHash: string): Promise<TransactionChainInfo> {
    const info = await this.getTransaction(txHash);
    if (info.error) {
      throw new CkbUnavailableError(
        "The CKB RPC node is currently unavailable",
        info.error,
      );
    }
    return info;
  }

  /**
   * Maps a chain status onto the four application states used by the UI.
   * `sent` is reported as `submitted` because the node accepted but has not
   * confirmed the transaction yet.
   *
   * A `null` status means "the node has never heard of this hash" and maps to
   * `failed`; callers that need to distinguish an unknown hash from a rejection
   * must check `TransactionChainInfo.found` first.
   */
  static toApplicationStatus(
    status: CkbTransactionStatus | null,
  ): "submitted" | "pending" | "committed" | "failed" {
    switch (status) {
      case "committed":
        return "committed";
      case "sent":
        return "submitted";
      case "pending":
      case "proposed":
      case "unknown":
        return "pending";
      case "rejected":
      case null:
        return "failed";
    }
  }
}
