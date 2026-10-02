import type { NextFunction, Request, Response } from "express";

import type { CkbClientService } from "../services/ckb/client.js";

export interface HealthDeps {
  ckb: CkbClientService;
  startedAt: Date;
}

/**
 * `GET /api/health`
 *
 * Reports API liveness plus a best-effort CKB RPC probe. The `chain.reachable`
 * flag lets the frontend show an explicit "CKB Testnet unreachable" banner
 * instead of pretending everything is fine.
 */
export function healthController({ ckb, startedAt }: HealthDeps) {
  return async function health(
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): Promise<void> {
    const reachable = await ckb.ping();
    let tipBlockNumber: string | null = null;

    if (reachable) {
      try {
        tipBlockNumber = await ckb.getTipBlockNumber();
      } catch {
        tipBlockNumber = null;
      }
    }

    res.json({
      data: {
        status: reachable ? "ok" : "degraded",
        service: "ckb-digital-credential-service",
        version: "1.0.0",
        uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        startedAt: startedAt.toISOString(),
        timestamp: new Date().toISOString(),
        chain: {
          network: ckb.network,
          addressPrefix: ckb.addressPrefix,
          rpcUrl: ckb.rpcUrl,
          reachable,
          tipBlockNumber,
        },
      },
    });
  };
}
