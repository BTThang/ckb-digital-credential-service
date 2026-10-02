import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCredentialSchema, upsertTransactionSchema } from "../validation/credential.schema.js";
import { isSporeId, normalizeSporeId } from "../services/ckb/spore.service.js";
import { CkbTransactionService, toChainStatus } from "../services/ckb/transaction.service.js";
import { createTestRepositories, fixtures, validCredentialInput } from "./fixtures.js";

describe("spore id validation", () => {
  it("accepts a bare 32-byte spore id", () => {
    // A Spore v2 id is the cell's type script args - a 32-byte value produced by
    // `hashTypeId(input, outputIndex)`. It is not an outpoint.
    const result = createCredentialSchema.safeParse(validCredentialInput());
    expect(result.success).toBe(true);
  });

  it("rejects an outpoint as a spore id", () => {
    // The outpoint looks superficially similar, and was previously accepted by
    // mistake. It can never match a cell, so accepting it only hid the bug.
    const result = createCredentialSchema.safeParse(
      validCredentialInput({ sporeId: `${fixtures.TX_HASH}0x0` }),
    );
    expect(result.success).toBe(false);
  });

  it("isSporeId agrees with the schema", () => {
    expect(isSporeId(fixtures.SPORE_ID)).toBe(true);
    expect(isSporeId(fixtures.SPORE_ID.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(isSporeId(`${fixtures.TX_HASH}0x0`)).toBe(false);
    expect(isSporeId("nope")).toBe(false);
  });

  it("validates sporeId on transaction upserts too", () => {
    const result = upsertTransactionSchema.safeParse({
      txHash: fixtures.TX_HASH,
      type: "CREATE_CREDENTIAL",
      status: "submitted",
      sporeId: `${fixtures.TX_HASH}0x0`,
    });
    expect(result.success).toBe(false);
  });

  it("normalises a pasted id", () => {
    expect(normalizeSporeId(`  ${fixtures.SPORE_ID.toUpperCase().replace("0X", "0x")}  `)).toBe(
      fixtures.SPORE_ID,
    );
  });
});

describe("transaction status mapping", () => {
  it("never reports an unknown hash as committed", () => {
    // `null` = the node has never heard of the hash.
    expect(CkbTransactionService.toApplicationStatus(null)).toBe("failed");
    expect(CkbTransactionService.toApplicationStatus("rejected")).toBe("failed");
    expect(CkbTransactionService.toApplicationStatus("pending")).toBe("pending");
    expect(CkbTransactionService.toApplicationStatus("proposed")).toBe("pending");
    expect(CkbTransactionService.toApplicationStatus("unknown")).toBe("pending");
    expect(CkbTransactionService.toApplicationStatus("sent")).toBe("submitted");
    expect(CkbTransactionService.toApplicationStatus("committed")).toBe("committed");
  });

  it("normalises unexpected node statuses to unknown", () => {
    expect(toChainStatus("committed")).toBe("committed");
    expect(toChainStatus("something-else")).toBe("unknown");
    expect(toChainStatus(undefined)).toBe("unknown");
  });
});

describe("credential repository", () => {
  let ctx: ReturnType<typeof createTestRepositories>;

  beforeEach(() => {
    ctx = createTestRepositories();
  });

  afterEach(() => {
    ctx.db.close();
  });

  it("creates a credential and finds it by spore id (case-insensitive)", () => {
    const record = ctx.repositories.credentials.create(
      createCredentialSchema.parse(validCredentialInput()),
    );

    expect(record.status).toBe("pending");
    expect(
      ctx.repositories.credentials.findBySporeId(fixtures.SPORE_ID.toUpperCase()),
    ).not.toBeNull();
  });

  it("lists with a total and filters by status", () => {
    ctx.repositories.credentials.create(
      createCredentialSchema.parse(validCredentialInput()),
    );

    const all = ctx.repositories.credentials.list({
      limit: 25,
      offset: 0,
    });
    expect(all.total).toBe(1);

    const filtered = ctx.repositories.credentials.list({
      limit: 25,
      offset: 0,
      status: "melted",
    });
    expect(filtered.total).toBe(0);
  });

  it("upserts a transaction idempotently and reconciles it", () => {
    const first = ctx.repositories.transactions.upsert({
      txHash: fixtures.TX_HASH,
      type: "CREATE_CREDENTIAL",
      status: "submitted",
    });
    const second = ctx.repositories.transactions.upsert({
      txHash: fixtures.TX_HASH,
      type: "CREATE_CREDENTIAL",
      status: "pending",
    });

    expect(second.id).toBe(first.id);
    expect(ctx.repositories.transactions.list(25, 0).total).toBe(1);

    const updated = ctx.repositories.transactions.updateStatus(
      fixtures.TX_HASH,
      "committed",
      "22574077",
    );
    expect(updated?.status).toBe("committed");
    expect(updated?.blockNumber).toBe("22574077");
  });

  it("deleting a credential cascades to its transactions", () => {
    const record = ctx.repositories.credentials.create(
      createCredentialSchema.parse(validCredentialInput()),
    );
    ctx.repositories.transactions.upsert({
      txHash: fixtures.TX_HASH,
      credentialId: record.id,
      type: "CREATE_CREDENTIAL",
      status: "submitted",
    });

    ctx.repositories.credentials.delete(record.id);

    expect(ctx.repositories.transactions.findByTxHash(fixtures.TX_HASH)).toBeNull();
  });
});

describe("row rehydration", () => {
  let ctx: ReturnType<typeof createTestRepositories>;

  beforeEach(() => {
    ctx = createTestRepositories();
  });

  afterEach(() => {
    ctx.db.close();
  });

  it("coerces an unrecognised enum instead of casting it through", () => {
    const record = ctx.repositories.credentials.create(
      createCredentialSchema.parse(validCredentialInput()),
    );
    ctx.repositories.transactions.upsert({
      txHash: fixtures.TX_HASH,
      type: "CREATE_CREDENTIAL",
      status: "submitted",
    });

    // The migration declares these columns as unconstrained TEXT, so a value
    // this build does not know about is reachable. It must degrade to a safe
    // fallback rather than reach API clients claiming to be a valid value.
    ctx.db.raw
      .prepare(
        `UPDATE credentials SET status = 'revoked', credential_type = 'MYSTERY' WHERE id = ?`,
      )
      .run(record.id);
    ctx.db.raw
      .prepare(`UPDATE transactions SET status = 'conflicted' WHERE tx_hash = ?`)
      .run(fixtures.TX_HASH);

    expect(ctx.repositories.credentials.findById(record.id)).toMatchObject({
      status: "unknown",
      credentialType: "OTHER",
    });
    expect(ctx.repositories.transactions.findByTxHash(fixtures.TX_HASH)?.status).toBe(
      "pending",
    );
  });
});
