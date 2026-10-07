import type { CkbNetwork } from "../config/index.js";
import type {
  CredentialRecord,
  PublicVerification,
  SporeVerificationResult,
} from "../types/domain.js";
import { NotFoundError } from "../utils/errors.js";
import type { CredentialRepository } from "../repositories/credential.repository.js";
import type { SporeService } from "./ckb/spore.service.js";

/**
 * The only credential-level validity rule available today: an expired
 * credential is `invalid` even while its cell is alive. End-of-day UTC, which
 * is what the web app's `isExpired` applies — the two must agree or the page
 * and the API would contradict each other.
 */
function isExpired(expirationDate: string | null | undefined): boolean {
  if (!expirationDate) return false;
  return Date.parse(`${expirationDate}T23:59:59Z`) < Date.now();
}

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
   * The public verification verdict behind `GET /api/verify/:credentialId`.
   *
   * It reuses `verifySporeId` — the single chain-reading path — and only maps
   * the result onto the public envelope, so there is no second place where a
   * cell is read or a state decided. No index lookup happens here at all: a
   * third party asks the chain, and the answer carries no database fields.
   */
  async verifyPublic(sporeId: string): Promise<PublicVerification> {
    const verification = await this.verifySporeId(sporeId);
    const { state, content } = verification;

    const blockchain = {
      network: verification.network,
      status:
        state === "verified"
          ? ("active" as const)
          : state === "not_found"
            ? ("not_found" as const)
            : ("unknown" as const),
      sporeId: verification.sporeId,
      currentOwner: verification.currentOwner,
      // Without a status there is no transaction to point at: an id alone
      // cannot reveal one, so it is reported as null rather than as the id.
      creationTxHash: verification.creationTxStatus
        ? verification.creationTxHash
        : null,
    };

    if (state === "unable_to_verify") {
      return {
        valid: false,
        state: "unable_to_verify",
        source: "ckb",
        reason:
          verification.reason ??
          "The CKB network could not be queried right now",
        checkedAt: verification.checkedAt,
        credential: null,
        blockchain,
      };
    }

    if (state === "not_found") {
      return {
        valid: false,
        state: "not_found",
        source: "ckb",
        reason: verification.reason ?? "No live Spore cell has this id",
        checkedAt: verification.checkedAt,
        credential: null,
        blockchain,
      };
    }

    // From here the cell is live, so the credential exists and can be shown —
    // including when it fails a validity rule (spec: invalid ≠ not found).
    const credential = {
      id: verification.sporeId,
      title: content?.title ?? null,
      type: content?.credentialType ?? null,
      issuer: content
        ? { name: content.issuerName, type: content.issuerType ?? null }
        : null,
      holder: verification.currentOwner,
      issuedAt: content?.issueDate ?? null,
      expiresAt: content?.expirationDate ?? null,
    };

    if (!content) {
      return {
        valid: false,
        state: "invalid",
        source: "ckb",
        reason: "The cell payload does not decode to a credential",
        checkedAt: verification.checkedAt,
        credential,
        blockchain,
      };
    }

    if (isExpired(content.expirationDate)) {
      return {
        valid: false,
        state: "invalid",
        source: "ckb",
        reason: `Expired on ${content.expirationDate}`,
        checkedAt: verification.checkedAt,
        credential,
        blockchain,
      };
    }

    return {
      valid: true,
      state: "active",
      source: "ckb",
      reason: null,
      checkedAt: verification.checkedAt,
      credential,
      blockchain,
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
