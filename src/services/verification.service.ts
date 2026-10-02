import type { CkbNetwork } from "../config/index.js";
import type { CredentialRecord, SporeVerificationResult } from "../types/domain.js";
import { NotFoundError } from "../utils/errors.js";
import type { CredentialRepository } from "../repositories/credential.repository.js";
import type { SporeService } from "./ckb/spore.service.js";

export interface VerificationReport {
  credential: CredentialRecord;
  /** The only field a client should treat as authoritative. */
  state: SporeVerificationResult["state"];
  verification: SporeVerificationResult;
  /** Index-only context. Never used to decide `state`. */
  indexed: {
    foundInDatabase: true;
    statusInDatabase: CredentialRecord["status"];
    ownerInDatabase: string;
    /** True when the indexed owner still matches the chain. */
    ownerMatchesChain: boolean | null;
    /** Field-by-field comparison of on-chain payload vs indexed metadata. */
    metadataMatchesChain: boolean | null;
    mismatchedFields: string[];
    /** True when the index was stale and has just been reconciled. */
    reconciled: boolean;
  };
}

/**
 * Turns a chain read into the public verification payload.
 * This is the ONLY place that decides between the three verification states.
 */
export class VerificationService {
  constructor(
    private readonly spores: SporeService,
    private readonly network: CkbNetwork,
  ) { }

  /**
   * Verifies a raw spore id, without any database involvement.
   *
   * `creationTxHashHint` is optional context used solely to explain a
   * `not_found` (did this ever commit, i.e. is this a melt?). It is never able
   * to produce a `verified`, which requires a live cell.
   */
  async verifySporeId(
    sporeId: string,
    creationTxHashHint?: string | null,
  ): Promise<SporeVerificationResult> {
    const checkedAt = new Date().toISOString();
    const result = await this.spores.verifySpore(sporeId, creationTxHashHint);
    const { spore, creationTx, state } = result;

    const reason =
      state === "verified"
        ? null
        : state === "unable_to_verify"
          ? (creationTx.error ??
            spore.error ??
            "The CKB network could not be queried for this Spore")
          : (creationTx.reason ??
            spore.error ??
            "No live Spore cell was found for this id (never created, not committed, or melted)");

    return {
      state,
      sporeId: sporeId.trim(),
      network: this.network,
      checkedAt,
      sporeExists: spore.exists,
      currentOwner: spore.owner,
      ownerLock: spore.ownerLock,
      contentType: spore.contentType,
      content: spore.content,
      rawContent: spore.rawContent,
      clusterId: spore.clusterId,
      creationTxHash: creationTx.txHash,
      creationTxStatus: creationTx.status,
      blockNumber: creationTx.blockNumber,
      capacity: spore.capacity,
      reason,
    };
  }

  /**
   * Verifies a credential and reconciles the local index with the chain.
   *
   * Note the direction of trust: the database is *updated from* the chain, it is
   * never used to answer the verification question.
   */
  async verifyCredential(
    repository: CredentialRepository,
    credential: CredentialRecord,
  ): Promise<VerificationReport> {
    const verification = await this.verifySporeId(
      credential.sporeId,
      credential.creationTxHash,
    );

    const mismatchedFields: string[] = [];
    let metadataMatchesChain: boolean | null = null;

    if (verification.state === "verified" && verification.content) {
      const chain = verification.content;
      const pairs: Array<[string, unknown, unknown]> = [
        ["title", chain.title, credential.title],
        ["description", chain.description, credential.description],
        ["issuerName", chain.issuerName, credential.issuerName],
        ["credentialType", chain.credentialType, credential.credentialType],
        ["issueDate", chain.issueDate, credential.issueDate],
        ["expirationDate", chain.expirationDate ?? null, credential.expirationDate],
      ];
      for (const [field, onChain, indexed] of pairs) {
        if (String(onChain ?? "") !== String(indexed ?? "")) {
          mismatchedFields.push(field);
        }
      }
      metadataMatchesChain = mismatchedFields.length === 0;
    }

    // Reflect the chain truth back into the index.
    const nextStatus: CredentialRecord["status"] =
      verification.state === "verified"
        ? "active"
        : verification.state === "not_found" &&
          verification.creationTxStatus === "committed"
          ? "melted"
          : verification.state === "not_found"
            ? "pending"
            : "unknown";

    const indexedStatusBeforeUpdate = credential.status;
    const indexedOwnerBeforeUpdate = credential.ownerAddress;

    const updated =
      repository.applyChainState(credential.id, {
        status: nextStatus,
        ownerAddress: verification.currentOwner,
      }) ?? credential;

    const indexAgreesWithChain =
      updated.status === nextStatus &&
      updated.ownerAddress === verification.currentOwner;

    return {
      credential: updated,
      state: verification.state,
      verification,
      indexed: {
        foundInDatabase: true,
        statusInDatabase: indexedStatusBeforeUpdate,
        ownerInDatabase: indexedOwnerBeforeUpdate,

        ownerMatchesChain:
          verification.currentOwner === null
            ? null
            : indexedOwnerBeforeUpdate === verification.currentOwner,

        metadataMatchesChain,
        mismatchedFields,

        reconciled: indexAgreesWithChain,
      },
    };
  }

  async requireCredential(
    repository: CredentialRepository,
    id: string,
  ): Promise<CredentialRecord> {
    const credential = repository.findById(id);
    if (!credential) {
      throw new NotFoundError(`Credential "${id}" was not found in the index`);
    }
    return credential;
  }
}
