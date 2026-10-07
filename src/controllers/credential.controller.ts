import type { NextFunction, Request, Response } from "express";

import type { CredentialService } from "../services/credential.service.js";
import type { SporeService } from "../services/ckb/spore.service.js";
import type { VerificationService } from "../services/verification.service.js";
import type { CkbTransactionService } from "../services/ckb/transaction.service.js";
import { isSporeId } from "../services/ckb/spore.service.js";
import { ValidationError } from "../utils/errors.js";
import { errorMessage } from "../utils/errors.js";
import type {
  CreateCredentialInput,
  ListCredentialsQuery,
  UpdateCredentialInput,
} from "../validation/credential.schema.js";

export interface CredentialControllerDeps {
  credentials: CredentialService;
  verification: VerificationService;
  spores: SporeService;
  transactions: CkbTransactionService;
}

export function credentialController(deps: CredentialControllerDeps) {
  const { credentials, verification, spores } = deps;

  return {
    /** `GET /api/credentials` */
    list(req: Request, res: Response, _next: NextFunction): void {
      const query = req.query as unknown as ListCredentialsQuery;
      const result = credentials.list(query);

      res.json({
        data: result.data,
        meta: {
          total: result.total,
          limit: query.limit,
          offset: query.offset,
        },
      });
    },

    /** `GET /api/credentials/:id` */
    get(req: Request, res: Response, _next: NextFunction): void {
      const { id } = req.params as { id: string };
      const credential = credentials.get(id);

      res.json({
        data: {
          credential,
          onChain: {
            sporeId: credential.sporeId,
            ownerAddress: credential.ownerAddress,
            creationTxHash: credential.creationTxHash,
            network: credential.network,
          },
        },
      });
    },

    /** `POST /api/credentials` */
    create(req: Request, res: Response, _next: NextFunction): void {
      const input = req.body as CreateCredentialInput;
      const credential = credentials.create(input);

      res.status(201).json({ data: credential });
    },

    /** `PATCH /api/credentials/:id` */
    update(req: Request, res: Response, _next: NextFunction): void {
      const { id } = req.params as { id: string };
      const patch = req.body as UpdateCredentialInput;
      const credential = credentials.update(id, patch);

      res.json({ data: credential });
    },

    /** `DELETE /api/credentials/:id` - removes the local index entry only. */
    remove(req: Request, res: Response, _next: NextFunction): void {
      const { id } = req.params as { id: string };
      credentials.remove(id);
      res.status(204).send();
    },

    /**
     * `GET /api/credentials/:id/verify`
     *
     * The response always contains a chain-derived `state`. A record in the
     * database alone can never produce `state: "verified"`.
     */
    async verify(req: Request, res: Response, _next: NextFunction): Promise<void> {
      const { id } = req.params as { id: string };
      const report = await credentials.verify(id);

      res.json({
        data: {
          state: report.state,
          verification: report.verification,
          indexed: report.indexed,
          credential: report.credential,
        },
      });
    },

    /** `POST /api/credentials/sync` - re-reads every index entry from chain. */
    async sync(_req: Request, res: Response, _next: NextFunction): Promise<void> {
      const summary = await credentials.sync();
      res.json({ data: summary });
    },

    /**
     * `GET /api/spores/lookup?sporeId=...`
     *
     * Resolves a spore id to an indexed credential so the Verify page can show
     * off-chain metadata next to the on-chain facts. The indexed record is
     * returned as context only - it never influences `state`.
     */
    lookup(req: Request, res: Response, _next: NextFunction): void {
      const { sporeId } = req.query as { sporeId?: string };

      if (!sporeId) {
        throw new ValidationError("sporeId query parameter is required");
      }
      if (!isSporeId(sporeId)) {
        throw new ValidationError(
          "sporeId must be 0x followed by 64 hex characters",
        );
      }

      const indexed = credentials.findBySporeId(sporeId);
      res.json({ data: indexed });
    },

    /**
     * `GET /api/spores/:sporeId/verify` - verification without an index entry.
     *
     * The creation transaction is reported by `verification` because it can only
     * be learned from the live cell's outpoint; a Spore id does not encode it.
     */
    async verifySporeId(
      req: Request,
      res: Response,
      _next: NextFunction,
    ): Promise<void> {
      const { sporeId } = req.params as { sporeId: string };
      const report = await verification.verifySporeId(sporeId);

      res.json({
        data: {
          state: report.state,
          verification: report,
          indexed: null,
        },
      });
    },

    /**
     * `GET /api/verify/:credentialId` - the third-party integration surface.
     *
     * No session, no index, no database fields: the verdict comes from
     * `VerificationService.verifyPublic`, which reads the live cell and applies
     * the validity rules. `valid: false` with `state: "unable_to_verify"` is an
     * infrastructure answer and must not be read as a credential verdict.
     */
    async verifyPublic(
      req: Request,
      res: Response,
      _next: NextFunction,
    ): Promise<void> {
      const { credentialId } = req.params as { credentialId: string };
      const result = await verification.verifyPublic(credentialId);

      res.json({ data: result });
    },

    /** `GET /api/spores/owner/:address` - live Spores owned by an address. */
    async listByOwner(
      req: Request,
      res: Response,
      _next: NextFunction,
    ): Promise<void> {
      const { address } = req.params as { address: string };

      try {
        const lock = await spores.getLock(address);
        const owned = await spores.findSporesByOwner(lock);
        res.json({ data: owned, meta: { total: owned.length } });
      } catch (error) {
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: `Unable to read Spores for address: ${errorMessage(error)}`,
          },
        });
      }
    },
  };
}
