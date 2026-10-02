import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type * as SporeTypes from "@ckb-ccc/spore";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { findSporeMock, findSporesMock } = vi.hoisted(() => ({
  findSporeMock: vi.fn(),
  findSporesMock: vi.fn(),
}));

vi.mock("@ckb-ccc/spore", async (importOriginal) => {
  const actual = await importOriginal<typeof SporeTypes>();
  return {
    ...actual,
    findSpore: (client: unknown, id: string) => findSporeMock(client, id),
    findSpores: (query: unknown) => findSporesMock(query),
  };
});

const { createApp } = await import("../app.js");
const { createAppContext } = await import("../context.js");
const { AppDatabase } = await import("../db/database.js");
const { createTestEnv } = await import("./env-fixture.js");
const { createFakeCkbClient, fixtures, chainCell } = await import(
  "./ckb-fixture.js"
);

/** Shape of every JSON body the API returns. */
interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * `getTransaction` as seen on the fake client. The real signature returns a
 * `ClientTransactionResponse`, which these stubs deliberately do not build, so
 * the seam is cast here once instead of at every assignment.
 */
type FakeGetTransaction = (txHash: unknown) => Promise<unknown>;

/**
 * Deterministic `getTransaction` answers, kept next to the fake client so the
 * two cannot drift. Individual tests swap this in and out via `workingNode()`.
 */
function fakeTransactions(txHash: string) {
  const normalized = txHash.toLowerCase();
  const response = (status: string) => ({
    status,
    blockNumber: status === "committed" ? 22_574_077n : undefined,
    blockHash: status === "committed" ? `0x${"e".repeat(64)}` : undefined,
    reason: undefined,
    transaction: { inputs: [], outputs: [] },
  });

  if (
    normalized === fixtures.TX_HASH ||
    normalized === fixtures.MELTED_TX_HASH
  ) {
    return response("committed");
  }
  if (normalized === fixtures.BROKEN_TX_HASH) return response("pending");
  return undefined;
}
describe("HTTP API", () => {
  let server: Server;
  let base: string;
  let context: Awaited<ReturnType<typeof createAppContext>>;

  async function api<T = any>(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const response = await fetch(`${base}${path}`, init);
    return {
      status: response.status,
      body: (await response.json()) as Envelope<T>,
    };
  }

  const json = (payload: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  beforeAll(async () => {
    const database = AppDatabase.open(":memory:");
    database.migrate();

    const testEnv = createTestEnv();

    context = createAppContext({
      env: testEnv,
      network: "testnet",
      database,
      ckbClient: createFakeCkbClient(),
    });

    const app = createApp(testEnv, context);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await context.dispose();
  });

  it("GET /api/health reports the node tip", async () => {
    const { status, body } = await api("/api/health");

    expect(status).toBe(200);
    expect(body.data.status).toBe("ok");
    expect(body.data.chain.network).toBe("testnet");
    expect(body.data.chain.reachable).toBe(true);
  });

  it("rejects an unknown route with a JSON 404", async () => {
    const { status, body } = await api("/api/nope");

    expect(status).toBe(404);
    expect(body.error!.code).toBe("NOT_FOUND");
  });

  it("rejects a cell outpoint submitted as a spore id", async () => {
    const { status, body } = await api(
      "/api/credentials",
      json({
        sporeId: `${fixtures.TX_HASH}0x0`,
        title: "Bad spore id",
        issuerName: "CKB Academy",
        issuerAddress: fixtures.ISSUER,
        recipientAddress: fixtures.ISSUER,
        credentialType: "COURSE_COMPLETION",
        issueDate: "2026-01-15",
        creationTxHash: fixtures.TX_HASH,
        network: "testnet",
      }),
    );

    expect(status).toBe(400);
    expect(body.error!.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(body.error!.details)).toContain("Spore id");
  });

  /**
   * Shared setup for the tests that need a working node. The "node is
   * unreachable" test replaces `getTransaction` with one that throws, so the
   * original is restored here rather than relying on declaration order.
   */
  function workingNode() {
    const getTransaction: FakeGetTransaction = async (txHash) =>
      fakeTransactions(String(txHash));
    context.services.ckbClient.client.getTransaction =
      getTransaction as unknown as typeof context.services.ckbClient.client.getTransaction;
  }

  it("indexes a credential and then verifies it against the chain", async () => {
    const created = await api(
      "/api/credentials",
      json({
        sporeId: fixtures.SPORE_ID,
        title: "Advanced TypeScript",
        description: "Completed the advanced TypeScript course",
        issuerName: "CKB Academy",
        issuerType: "SCHOOL",
        issuerAddress: fixtures.ISSUER,
        recipientAddress: fixtures.RECIPIENT,
        credentialType: "COURSE_COMPLETION",
        issueDate: "2026-01-15",
        creationTxHash: fixtures.TX_HASH,
        network: "testnet",
      }),
    );

    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe("pending");
    expect(created.body.data.ownerAddress).toBe(fixtures.RECIPIENT);

    workingNode();
    findSporeMock.mockResolvedValue(chainCell(fixtures.TX_HASH));

    const verified = await api(
      `/api/credentials/${created.body.data.id}/verify`,
    );

    expect(verified.status).toBe(200);
    expect(verified.body.data.state).toBe("verified");
    // The owner came from the chain, not from the request body.
    expect(verified.body.data.credential.ownerAddress).toBe(
      fixtures.CHAIN_OWNER,
    );
    expect(verified.body.data.credential.status).toBe("active");
    expect(verified.body.data.indexed.ownerInDatabase).toBe(
      fixtures.RECIPIENT,
    );
    expect(verified.body.data.indexed.ownerMatchesChain).toBe(false);
    expect(verified.body.data.indexed.reconciled).toBe(true);
    expect(verified.body.data.indexed.metadataMatchesChain).toBe(true);
  });

  it("answers not_found (not an error) for a melted spore", async () => {
    const created = await api(
      "/api/credentials",
      json({
        sporeId: fixtures.MELTED_SPORE_ID,
        title: "Revoked certificate",
        issuerName: "CKB Academy",
        issuerType: "SCHOOL",
        issuerAddress: fixtures.ISSUER,
        recipientAddress: fixtures.RECIPIENT,
        credentialType: "OTHER",
        issueDate: "2026-02-01",
        creationTxHash: fixtures.MELTED_TX_HASH,
        network: "testnet",
      }),
    );

    // No live Spore cell remains, but the indexed creation tx is committed,
    // which is what distinguishes a melt from a never-created credential.
    workingNode();
    findSporeMock.mockResolvedValue(undefined);

    const { status, body } = await api(
      `/api/credentials/${created.body.data.id}/verify`,
    );

    expect(status).toBe(200);
    expect(body.data.state).toBe("not_found");
    expect(body.data.verification.creationTxStatus).toBe("committed");
    expect(body.data.credential.status).toBe("melted");
  });

  it("keeps a credential pending while its creation tx is uncommitted", async () => {
    const created = await api(
      "/api/credentials",
      json({
        sporeId: fixtures.BROKEN_SPORE_ID,
        title: "Credential on a flaky node",
        issuerName: "CKB Academy",
        issuerAddress: fixtures.ISSUER,
        recipientAddress: fixtures.RECIPIENT,
        credentialType: "OTHER",
        issueDate: "2026-03-01",
        creationTxHash: fixtures.BROKEN_TX_HASH,
        network: "testnet",
      }),
    );

    // The cell is live and decodes, but the node reports its creating
    // transaction as still pending -> not verifiable, and never "melted".
    workingNode();
    findSporeMock.mockResolvedValue(chainCell(fixtures.BROKEN_TX_HASH));

    const { status, body } = await api(
      `/api/credentials/${created.body.data.id}/verify`,
    );

    expect(status).toBe(200);
    expect(body.data.state).toBe("not_found");
    expect(body.data.verification.creationTxStatus).toBe("pending");
    expect(body.data.credential.status).toBe("pending");
  });

  it("reports unable_to_verify when the node is unreachable", async () => {
    const created = await api(
      "/api/credentials",
      json({
        sporeId: `0x${"4".repeat(64)}`,
        title: "Credential on a dead node",
        issuerName: "CKB Academy",
        issuerAddress: fixtures.ISSUER,
        recipientAddress: fixtures.RECIPIENT,
        credentialType: "OTHER",
        issueDate: "2026-04-01",
        creationTxHash: fixtures.MELTED_TX_HASH,
        network: "testnet",
      }),
    );

    // A live cell whose creating tx cannot be read is "unable to verify".
    // Reporting "melted" here would wrongly tell a holder their credential is
    // gone, so the distinction matters.
    findSporeMock.mockResolvedValue(chainCell(fixtures.MELTED_TX_HASH));
    const deadNode: FakeGetTransaction = async () => {
      throw new Error("connection refused");
    };
    context.services.ckbClient.client.getTransaction =
      deadNode as unknown as typeof context.services.ckbClient.client.getTransaction;

    const { status, body } = await api(
      `/api/credentials/${created.body.data.id}/verify`,
    );

    expect(status).toBe(200);
    expect(body.data.state).toBe("unable_to_verify");
    expect(body.data.verification.creationTxStatus).toBeNull();
    expect(body.data.credential.status).toBe("unknown");
  });

  it("404s a credential that was never indexed", async () => {
    const { status, body } = await api("/api/credentials/does-not-exist");

    expect(status).toBe(404);
    expect(body.error!.code).toBe("NOT_FOUND");
  });

  it("refuses a second index entry for the same spore id", async () => {
    // The Spore id is the credential's identity on chain, so re-posting one
    // must not create a second index row that could disagree with the first.
    workingNode();
    const body = {
      sporeId: `0x${"5".repeat(64)}`,
      title: "Duplicate attempt",
      issuerName: "CKB Academy",
      issuerType: "SCHOOL",
      issuerAddress: fixtures.ISSUER,
      recipientAddress: fixtures.RECIPIENT,
      credentialType: "OTHER",
      issueDate: "2026-05-01",
      creationTxHash: `0x${"f".repeat(64)}`,
      network: "testnet",
    };

    const first = await api("/api/credentials", json(body));
    expect(first.status).toBe(201);

    const second = await api("/api/credentials", json(body));
    expect(second.status).toBe(409);
    expect(second.body.error!.code).toBe("CONFLICT");

    const list = await api("/api/credentials?search=Duplicate");
    expect(list.body.meta!.total).toBe(1);
  });

  it("reconciles a transfer made outside this UI", async () => {
    // The whole point of the index is that a chain change made by any wallet is
    // picked up: the stored owner must be corrected from the live cell.
    workingNode();
    const created = await api(
      "/api/credentials",
      json({
        sporeId: `0x${"6".repeat(64)}`,
        title: "Transferred elsewhere",
        issuerName: "CKB Academy",
        issuerType: "SCHOOL",
        issuerAddress: fixtures.ISSUER,
        recipientAddress: fixtures.RECIPIENT,
        credentialType: "OTHER",
        issueDate: "2026-06-01",
        creationTxHash: fixtures.TX_HASH,
        network: "testnet",
      }),
    );

    expect(created.body.data.ownerAddress).toBe(fixtures.RECIPIENT);

    // The live cell is locked to a different address, as it would be after the
    // recipient transferred the credential in their own wallet.
    findSporeMock.mockResolvedValue(chainCell(fixtures.TX_HASH));

    const { status, body } = await api(
      `/api/credentials/${created.body.data.id}/verify`,
    );

    expect(status).toBe(200);
    expect(body.data.credential.ownerAddress).toBe(fixtures.CHAIN_OWNER);
    expect(body.data.indexed.ownerMatchesChain).toBe(false);
    expect(body.data.indexed.reconciled).toBe(true);
  });

  it("verifies a spore id directly, with no index entry", async () => {
    // The verification must work from the chain alone, and the creation tx has
    // to be read out of the cell's outpoint - a Spore id cannot provide it.
    workingNode();
    findSporeMock.mockResolvedValue(chainCell(fixtures.TX_HASH));

    const { status, body } = await api(
      `/api/spores/${fixtures.SPORE_ID}/verify`,
    );

    expect(status).toBe(200);
    expect(body.data.state).toBe("verified");
    // The creation tx came from the cell's outpoint, not from the Spore id.
    expect(body.data.verification.creationTxHash).toBe(fixtures.TX_HASH);
    expect(body.data.verification.creationTxStatus).toBe("committed");
    expect(body.data.verification.currentOwner).toBe(fixtures.CHAIN_OWNER);
  });

  it("returns the chain state for a tracked transaction", async () => {
    await api(
      "/api/transactions",
      json({
        txHash: fixtures.TX_HASH,
        type: "CREATE_CREDENTIAL",
        status: "submitted",
        detail: "Issued Advanced TypeScript",
      }),
    );

    const { status, body } = await api(
      `/api/transactions/${fixtures.TX_HASH}`,
    );

    expect(status).toBe(200);
    expect(body.data.chain.status).toBe("committed");
    expect(body.data.status).toBe("committed");
    expect(body.data.inSync).toBe(false);
  });

  it("404s a transaction hash the network has never seen", async () => {
    const { status, body } = await api(
      `/api/transactions/0x${"9".repeat(64)}`,
    );

    expect(status).toBe(404);
    expect(body.error!.code).toBe("NOT_FOUND");
  });

  it("POST /api/credentials/sync reconciles the whole index", async () => {
    workingNode();
    findSporeMock.mockResolvedValue(chainCell(fixtures.TX_HASH));

    const { status, body } = await api(
      "/api/credentials/sync",
      { method: "POST" },
    );

    expect(status).toBe(200);
    expect(body.data.credentials.scanned).toBeGreaterThan(0);
    expect(body.data.network).toBe("testnet");
  });
});
