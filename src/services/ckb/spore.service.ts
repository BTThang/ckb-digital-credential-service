import { ccc } from "@ckb-ccc/ccc";
import * as spore from "@ckb-ccc/spore";

import type { CkbNetwork } from "../../config/index.js";
import { errorMessage } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import type {
  SporeCredentialPayload,
  TransactionChainInfo,
} from "../../types/domain.js";
import type { CkbClientService } from "./client.js";
import { CkbTransactionService } from "./transaction.service.js";
import { SPORE_ID } from "../../validation/credential.schema.js";

/**
 * A Spore v2 id is a bare 32-byte value: the cell's *type script args*, which
 * `@ckb-ccc/spore` sets to `hashTypeId(firstInput, outputIndex)` and returns
 * from `createSpore`. It is deliberately **not** the cell outpoint.
 *
 * This matters beyond formatting. Because the id is a hash over
 * (input, index) rather than a copy of them, the creation transaction cannot be
 * recovered from it - the bytes of the id are not the transaction hash. The
 * creation tx has to come from the live cell's outpoint, or from the index.
 */
export function isSporeId(value: string): boolean {
  return SPORE_ID.test(value.trim());
}

/** Normalises a pasted id (people paste it in any case, with stray spaces). */
export function normalizeSporeId(value: string): string {
  return value.trim().toLowerCase();
}

/** Reads the Spore id back out of a cell, i.e. its type script args. */
export function sporeIdOf(cell: ccc.Cell): string {
  return ccc.hexFrom(cell.cellOutput.type?.args ?? "0x");
}

/**
 * Safely parse the Spore payload.
 *
 * The Spore content is user supplied, therefore untrusted: anything that fails
 * to parse is reported as `null` instead of throwing, and the raw value is kept
 * so the UI can still show it.
 */
export function parseSporeContent(
  contentType: string,
  content: ccc.BytesLike,
): { payload: SporeCredentialPayload | null; raw: string | null } {
  let raw: string;
  try {
    raw = new TextDecoder().decode(ccc.bytesFrom(content));
  } catch (error) {
    logger.warn("Unable to decode spore content as UTF-8", errorMessage(error));
    return { payload: null, raw: null };
  }

  if (!contentType.includes("json")) {
    return { payload: null, raw };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SporeCredentialPayload>;
    if (typeof parsed !== "object" || parsed === null) {
      return { payload: null, raw };
    }
    return { payload: parsed as SporeCredentialPayload, raw };
  } catch {
    return { payload: null, raw };
  }
}

export interface SporeOnChainState {
  exists: boolean;
  /** Lock script of the live Spore cell, exactly as stored on chain. */
  lock: ccc.Script | null;
  /** `lock` serialized as hex, safe to put in a JSON response. */
  ownerLock: string | null;
  /** Bech32m address of the current owner, `null` when not readable. */
  owner: string | null;
  contentType: string | null;
  content: SporeCredentialPayload | null;
  rawContent: string | null;
  clusterId: string | null;
  capacity: string | null;
  /**
   * Transaction that created the Spore, taken from the live cell's outpoint.
   * `null` while no cell is live - the id alone cannot reveal it.
   */
  creationTxHash: string | null;
  /** Populated when the spore cell exists but could not be read/decoded. */
  error: string | null;
}

const EMPTY_CHAIN_STATE: Omit<SporeOnChainState, "owner"> = {
  exists: false,
  lock: null,
  ownerLock: null,
  contentType: null,
  content: null,
  rawContent: null,
  clusterId: null,
  capacity: null,
  creationTxHash: null,
  error: null,
};

function emptyChainState(): SporeOnChainState {
  return { ...EMPTY_CHAIN_STATE, owner: null };
}

/**
 * A "we did not look this up" transaction result.
 *
 * Needed because the Spore id cannot yield a creation hash: without an indexed
 * hint there is genuinely no transaction to ask the node about, and reporting
 * that as `found: false` would wrongly read as "the node rejected it".
 */
function emptyTx(txHash: string): TransactionChainInfo {
  return {
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
}

/**
 * Read-only Spore queries backed by the CKB node.
 *
 * Every method answers with a *fact about the chain*; nothing here consults the
 * local database, so verification can never be satisfied by a stale index.
 */
export class SporeService {
  constructor(
    private readonly ckb: CkbClientService,
    /** Exposed so callers can label chain-derived results without a second source. */
    readonly network: CkbNetwork,
  ) {}

  get addressPrefix(): "ckb" | "ckt" {
    return this.ckb.addressPrefix;
  }

  async toAddress(lock: ccc.Script): Promise<string> {
    return ccc.Address.fromScript(lock, this.ckb.client).toString();
  }

  /** Validates a bech32m CKB address against the configured network. */
  async parseAddress(address: string): Promise<ccc.Address> {
    return ccc.Address.fromString(address.trim(), this.ckb.client);
  }

  async getLock(address: string): Promise<ccc.Script> {
    const parsed = await this.parseAddress(address);
    return parsed.script;
  }

  /** Returns the live Spore cell for `sporeId`, or a structured "missing". */
  async readSpore(sporeId: string): Promise<SporeOnChainState> {
    let found: Awaited<ReturnType<typeof spore.findSpore>>;
    try {
      found = await spore.findSpore(
        this.ckb.client,
        normalizeSporeId(sporeId),
      );
    } catch (error) {
      // The cell may exist while the data cannot be decoded (e.g. an older or
      // tampered Spore version). That is "unverifiable", never "not found".
      return { ...emptyChainState(), error: errorMessage(error) };
    }

    if (!found) return emptyChainState();

    const cell = found.cell;
    const { payload, raw } = parseSporeContent(
      found.sporeData.contentType,
      found.sporeData.content,
    );

    const lock = cell.cellOutput.lock;
    let owner: string | null = null;
    try {
      owner = await this.toAddress(lock);
    } catch (error) {
      logger.warn(
        `Unable to derive owner address for spore ${sporeId}`,
        errorMessage(error),
      );
    }

    return {
      exists: true,
      lock,
      ownerLock: ccc.hexFrom(lock.toBytes()),
      owner,
      contentType: found.sporeData.contentType,
      content: payload,
      rawContent: raw,
      clusterId: found.sporeData.clusterId
        ? ccc.hexFrom(found.sporeData.clusterId)
        : null,
      capacity: cell.cellOutput.capacity.toString(),
      creationTxHash: cell.outPoint.txHash,
      error: null,
    };
  }

  /**
   * Chain-authoritative verification of a Spore id.
   *
   * Three outcomes only:
   *  - `verified`         a live spore cell was found, decoded, and its
   *                       creation transaction is committed
   *  - `not_found`        no live cell - never created, not committed, or melted
   *  - `unable_to_verify` the node or the decoder failed, so no conclusion can
   *                       be drawn
   *
   * The live cell is the primary evidence, because it is the only thing that
   * carries the outpoint. `creationTxHashHint` is the indexed creation hash and
   * is used *only* to explain a `not_found` (was it ever committed, and is this
   * therefore a melt?) - it can never turn a `not_found` into a `verified`.
   */
  async verifySpore(
    sporeId: string,
    creationTxHashHint?: string | null,
  ): Promise<{
    state: "verified" | "not_found" | "unable_to_verify";
    spore: SporeOnChainState;
    creationTx: Awaited<ReturnType<CkbTransactionService["getTransaction"]>>;
  }> {
    const transactions = new CkbTransactionService(this.ckb);
    const chainState = await this.readSpore(sporeId);

    if (chainState.error) {
      return { state: "unable_to_verify", spore: chainState, creationTx: emptyTx(sporeId) };
    }

    // No live cell. The id is a hash, so the only way to learn whether this
    // credential was ever committed is the index hint.
    if (!chainState.exists) {
      const hint = creationTxHashHint?.trim();
      const creationTx = hint
        ? await transactions.getTransaction(hint)
        : emptyTx(sporeId);
      return { state: "not_found", spore: chainState, creationTx };
    }

    const creationTx = await transactions.getTransaction(
      chainState.creationTxHash!,
    );

    if (creationTx.error) {
      return { state: "unable_to_verify", spore: chainState, creationTx };
    }

    // A live cell whose creating transaction the node cannot confirm committed
    // is not yet verifiable, and it is definitely not "melted".
    if (!creationTx.found || creationTx.status !== "committed") {
      return { state: "not_found", spore: chainState, creationTx };
    }

    return { state: "verified", spore: chainState, creationTx };
  }

  /**
   * Best-effort search for Spores owned by `lock`.
   *
   * The indexer returns historical Spore versions that the current decoder
   * cannot read, so iteration is guarded and stops at the first failure instead
   * of taking down the whole request.
   */
  async findSporesByOwner(
    lock: ccc.Script,
    limit = 50,
  ): Promise<
    Array<{ sporeId: string; owner: string; data: SporeCredentialPayload | null }>
  > {
    const results: Array<{
      sporeId: string;
      owner: string;
      data: SporeCredentialPayload | null;
    }> = [];

    try {
      for await (const found of spore.findSpores({
        client: this.ckb.client,
        lock,
        limit,
        order: "desc",
      })) {
        const { payload } = parseSporeContent(
          found.sporeData.contentType,
          found.sporeData.content,
        );
        results.push({
          sporeId: sporeIdOf(found.spore),
          owner: await this.toAddress(found.spore.cellOutput.lock),
          data: payload,
        });
        if (results.length >= limit) break;
      }
    } catch (error) {
      logger.warn(
        "Spore indexer iteration stopped early (undecodable historical spore?)",
        errorMessage(error),
      );
    }

    return results;
  }

  async getBalance(address: string): Promise<string> {
    const lock = await this.getLock(address);
    return ccc.fixedPointToString(await this.ckb.client.getBalanceSingle(lock));
  }
}
