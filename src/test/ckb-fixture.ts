import { ccc } from "@ckb-ccc/ccc";

import type { CkbClientService } from "../services/ckb/client.js";
import type { SignatureInput } from "../validation/auth.schema.js";

export const TX_HASH = `0x${"b".repeat(64)}`;
export const MELTED_TX_HASH = `0x${"c".repeat(64)}`;
export const BROKEN_TX_HASH = `0x${"d".repeat(64)}`;

/**
 * Spore ids are bare 32-byte values (the type script args), not outpoints, so
 * each is distinct from its own `creationTxHash`. The creation tx is now only
 * discoverable from the live cell's outpoint, which is why `chainCell` carries
 * one - see `chainCell(creationTxHash)`.
 */
export const SPORE_ID = `0x${"1".repeat(64)}`;
export const MELTED_SPORE_ID = `0x${"2".repeat(64)}`;
export const BROKEN_SPORE_ID = `0x${"3".repeat(64)}`;

export const ISSUER = "ckt1qyq0000000000000000000000000000000000000";
export const RECIPIENT = "ckt1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5x6j0z9d0";

/** Secp256k1Blake160, the lock behind every address these signers produce. */
export const SECP256K1_BLAKE160_CODE_HASH =
  "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

/**
 * The on-chain owner is deliberately different from `RECIPIENT` so the tests
 * can prove that ownership is read from the chain and never from the DB.
 */
const OWNER_LOCK = ccc.Script.from({
  // Secp256k1Blake160 code hash
  codeHash: SECP256K1_BLAKE160_CODE_HASH,
  hashType: "type",
  args: "0x02" + "11".repeat(33),
});

export const CHAIN_OWNER = ccc.Address.fromScript(
  OWNER_LOCK,
  { addressPrefix: "ckt" } as unknown as ccc.Client,
).toString();

export const fixtures = {
  TX_HASH,
  MELTED_TX_HASH,
  BROKEN_TX_HASH,
  SPORE_ID,
  MELTED_SPORE_ID,
  BROKEN_SPORE_ID,
  ISSUER,
  RECIPIENT,
  CHAIN_OWNER,
};

/** A live Spore cell as returned by `spore.findSpore`. */
export function chainCell(creationTxHash: string = TX_HASH) {
  // `sporeData.content` is the raw cell data, i.e. hex-encoded on the wire.
  const content = `0x${Buffer.from(
    JSON.stringify({
      version: 1,
      title: "Advanced TypeScript",
      description: "Completed the advanced TypeScript course",
      issuerName: "CKB Academy",
      issuerType: "SCHOOL",
      credentialType: "COURSE_COMPLETION",
      issueDate: "2026-01-15",
      expirationDate: null,
      network: "testnet",
    }),
    "utf8",
  ).toString("hex")}`;

  return {
    cell: {
      // The outpoint is the only place the creation tx hash exists: the Spore
      // id is a hash over (input, index) and does not encode it.
      outPoint: { txHash: creationTxHash, index: "0x0" },
      cellOutput: {
        capacity: 1420.1,
        lock: OWNER_LOCK,
        type: { args: SPORE_ID },
      },
    },
    spore: {
      outPoint: { txHash: creationTxHash, index: "0x0" },
      cellOutput: {
        capacity: 1420.1,
        lock: OWNER_LOCK,
        type: { args: SPORE_ID },
      },
    },
    sporeData: {
      contentType: "application/json;version=1",
      content,
      clusterId: null,
    },
    scriptInfo: null,
  };
}

/**
 * A `CkbClientService` replacement that answers deterministically:
 *  - `TX_HASH` / `MELTED_TX_HASH` are committed
 *  - `BROKEN_TX_HASH` is known but still pending
 *  - anything else is unknown to the node
 */
export function createFakeCkbClient(): CkbClientService {
  const response = (status: string) => ({
    status,
    blockNumber: status === "committed" ? 22_574_077n : undefined,
    blockHash: status === "committed" ? `0x${"e".repeat(64)}` : undefined,
    reason: undefined,
    transaction: { inputs: [], outputs: [] },
  });

  const client = {
    addressPrefix: "ckt",
    getTip: async () => 22_574_100n,
    getTransaction: async (txHash: string) => {
      const normalized = txHash.toLowerCase();
      if (normalized === TX_HASH || normalized === MELTED_TX_HASH) {
        return response("committed");
      }
      if (normalized === BROKEN_TX_HASH) {
        return response("pending");
      }
      return undefined;
    },
  };

  return {
    network: "testnet",
    client,
    addressPrefix: "ckt",
    rpcUrl: "http://127.0.0.1:8114",
    getTipBlockNumber: async () => "22574100",
    ping: async () => true,
    dispose: async () => {},
  } as unknown as CkbClientService;
}

/**
 * The smallest client a `SignerCkbPrivateKey` can work with.
 *
 * Signing is entirely local, so nothing beyond the address prefix is needed -
 * except `getKnownScript`, which `SignerCkbPrivateKey.getInternalAddress()`
 * calls to turn its public key into an address.
 */
export function createSigningClient(
  addressPrefix: "ckb" | "ckt" = "ckt",
): ccc.Client {
  return {
    addressPrefix,
    getKnownScript: async (known: ccc.KnownScript) => {
      if (known === ccc.KnownScript.Secp256k1Blake160) {
        return ccc.Script.from({
          codeHash: SECP256K1_BLAKE160_CODE_HASH,
          hashType: "type",
          args: "0x" + "00".repeat(20),
        });
      }
      throw new Error(`Unsupported known script: ${known}`);
    },
  } as unknown as ccc.Client;
}

export interface TestWallet {
  signer: ccc.SignerCkbPrivateKey;
  address: string;
  /** The compressed public key CCC reports, which is *not* the address. */
  publicKey: string;
}

/**
 * A real signing wallet.
 *
 * Authentication tests must produce genuine signatures: a hand-written
 * signature fixture would pass while the actual verification path is broken.
 * `seed` only has to differ between wallets, and only needs to be a valid
 * secp256k1 scalar.
 */
export async function createTestWallet(
  seed: number,
  addressPrefix: "ckb" | "ckt" = "ckt",
): Promise<TestWallet> {
  const signer = new ccc.SignerCkbPrivateKey(
    createSigningClient(addressPrefix),
    `0x${seed.toString(16).padStart(2, "0").repeat(32)}`,
  );

  return {
    signer,
    address: await signer.getInternalAddress(),
    publicKey: await signer.getIdentity(),
  };
}

/** Signs `message` the way a CCC wallet does, in the shape the API expects. */
export async function signChallenge(
  wallet: TestWallet,
  message: string,
): Promise<SignatureInput> {
  const signed = await wallet.signer.signMessage(message);

  return {
    signature: signed.signature,
    identity: signed.identity,
    // `SignerCkbPrivateKey` only ever reports `CkbSecp256k1`; the API narrows
    // CCC's wider union, so the assertion is safe here.
    signType: signed.signType as SignatureInput["signType"],
  };
}
