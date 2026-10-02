import type { CkbNetwork } from "../config/index.js";
import type {
  CredentialRecord,
  CredentialStatus,
  TransactionRecord,
} from "../types/domain.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type {
  Repositories,
} from "../repositories/index.js";
import type {
  CreateCredentialInput,
  ListCredentialsQuery,
  UpdateCredentialInput,
} from "../validation/credential.schema.js";
import { type CkbTransactionService } from "./ckb/transaction.service.js";
import type { VerificationService } from "./verification.service.js";
import type { VerificationReport } from "./verification.service.js";

export interface SyncSummary {
  credentials: {
    scanned: number;
    updated: number;
    byStatus: Record<CredentialStatus, number>;
  };
  transactions: {
    scanned: number;
    updated: number;
  };
  network: CkbNetwork;
  finishedAt: string;
}

/**
 * Credential use-cases.
 *
 * Every method that needs chain truth delegates to {@link VerificationService};
 * nothing here trusts a value supplied by the request body for ownership or
 * status.
 */
export class CredentialService {
  constructor(
    private readonly repositories: Repositories,
    private readonly verification: VerificationService,
    private readonly transactions: CkbTransactionService,
    private readonly network: CkbNetwork,
  ) {}

  list(query: ListCredentialsQuery): { data: CredentialRecord[]; total: number } {
    return this.repositories.credentials.list(query);
  }

  get(id: string): CredentialRecord {
    const credential = this.repositories.credentials.findById(id);
    if (!credential) {
      throw new NotFoundError(`Credential "${id}" was not found`);
    }
    return credential;
  }

  /** Case-insensitive lookup used by the Verify page. */
  findBySporeId(sporeId: string): CredentialRecord | null {
    return this.repositories.credentials.findBySporeId(sporeId.trim().toLowerCase());
  }

  /**
   * Registers a credential that the client has already broadcast on chain.
   *
   * The client is the only party able to sign, so the spore id / tx hash come
   * from the wallet flow - but they are immediately re-checked against the
   * node by {@link verify}.
   */
  create(input: CreateCredentialInput): CredentialRecord {
    const sporeId = input.sporeId.toLowerCase();
    const existing = this.repositories.credentials.findBySporeId(sporeId);
    if (existing) {
      throw new ConflictError(
        `A credential with spore id ${sporeId} is already indexed`,
        { credentialId: existing.id },
      );
    }

    const created = this.repositories.credentials.create({
      ...input,
      sporeId,
      creationTxHash: input.creationTxHash.toLowerCase(),
    });

    this.repositories.transactions.upsert({
      txHash: input.creationTxHash,
      credentialId: created.id,
      sporeId,
      type: "CREATE_CREDENTIAL",
      status: "submitted",
      detail: `Issued "${created.title}"`,
    });

    return created;
  }

  update(id: string, patch: UpdateCredentialInput): CredentialRecord {
    this.get(id);
    const updated = this.repositories.credentials.update(id, patch);
    if (!updated) {
      throw new NotFoundError(`Credential "${id}" was not found`);
    }
    return updated;
  }

  remove(id: string): void {
    this.get(id);
    this.repositories.transactions.deleteByCredential(id);
    this.repositories.credentials.delete(id);
  }

  /** Blockchain-authoritative verification + index reconciliation. */
  verify(id: string): Promise<VerificationReport> {
    const credential = this.get(id);
    return this.verification.verifyCredential(
      this.repositories.credentials,
      credential,
    );
  }

  /**
   * Re-reads every indexed credential from the chain.
   *
   * This is what makes the list page trustworthy after a transfer or a melt
   * performed outside this UI.
   */
  async sync(): Promise<SyncSummary> {
    const credentials = this.repositories.credentials.findAll();
    const byStatus: Record<CredentialStatus, number> = {
      pending: 0,
      active: 0,
      melted: 0,
      unknown: 0,
    };

    let updated = 0;

    for (const credential of credentials) {
      try {
        const report = await this.verification.verifyCredential(
          this.repositories.credentials,
          credential,
        );
        if (report.credential.status !== credential.status) updated += 1;
        byStatus[report.credential.status] += 1;
      } catch (error) {
        byStatus.unknown += 1;
        logger.warn(
          `Failed to sync credential ${credential.id}`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    const pendingTransactions =
      this.repositories.transactions.listByStatus("submitted").length +
      this.repositories.transactions.listByStatus("pending").length;

    const updatedTransactions = await this.repositories.transactions.reconcile(
      this.transactions,
    );

    return {
      credentials: {
        scanned: credentials.length,
        updated,
        byStatus,
      },
      transactions: {
        scanned: pendingTransactions,
        updated: updatedTransactions,
      },
      network: this.network,
      finishedAt: new Date().toISOString(),
    };
  }

  trackTransaction(
    input: Parameters<Repositories["transactions"]["upsert"]>[0],
  ): TransactionRecord {
    return this.repositories.transactions.upsert(input);
  }
}
