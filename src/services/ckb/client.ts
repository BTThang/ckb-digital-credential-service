import { ccc } from "@ckb-ccc/ccc";

import type { CkbNetwork } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

/**
 * Owns the read-only CKB RPC client.
 *
 * The backend never signs or broadcasts: every write path lives in the browser
 * behind the user's wallet. This client is only ever used for reads (tips,
 * transactions, cells) which keeps the "no private keys on the server" rule
 * structurally enforced.
 */
export class CkbClientService {
  private readonly owner: ccc.Owner<ccc.Client>;

  constructor(
    readonly network: CkbNetwork,
    rpcUrls?: string[],
  ) {
    const open = (): ccc.Owner<ccc.Client> => {
      const config = rpcUrls?.length
        ? ({ urls: rpcUrls as unknown as readonly [string, ...string[]] } as never)
        : undefined;

      return network === "mainnet"
        ? ccc.ClientPublicMainnet.open(config)
        : ccc.ClientPublicTestnet.open(config);
    };

    this.owner = open();
    logger.info(
      `CKB ${network} client ready (address prefix: ${this.owner.value.addressPrefix})`,
    );
  }

  get client(): ccc.Client {
    return this.owner.value;
  }

  get addressPrefix(): "ckb" | "ckt" {
    return this.owner.value.addressPrefix === "ckb" ? "ckb" : "ckt";
  }

  get rpcUrl(): string {
    return this.owner.value.url;
  }

  async getTipBlockNumber(): Promise<string> {
    return (await this.client.getTip()).toString();
  }

  /** Cheap liveness probe used by `GET /api/health`. */
  async ping(): Promise<boolean> {
    try {
      await this.client.getTip();
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    await this.owner.dispose();
  }
}
