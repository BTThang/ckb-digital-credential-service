import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { credentialActors } from "../types/domain.js";
import { createCredentialSchema } from "../validation/credential.schema.js";
import {
  createTestRepositories,
  fixtures,
  validCredentialInput,
} from "./fixtures.js";

const HOLDER_A = `ckt1qyq${"a".repeat(38)}`;
const HOLDER_B = `ckt1qyq${"b".repeat(38)}`;

describe("credential actors", () => {
  let ctx: ReturnType<typeof createTestRepositories>;

  beforeEach(() => {
    ctx = createTestRepositories();
  });

  afterEach(() => {
    ctx.db.close();
  });

  const create = (overrides: Record<string, unknown> = {}) =>
    ctx.repositories.credentials.create(
      createCredentialSchema.parse(validCredentialInput(overrides)),
    );

  it("projects the issuer and the holder off an indexed record", () => {
    const record = create({ recipientAddress: HOLDER_A });

    expect(credentialActors(record)).toEqual({
      issuer: {
        address: fixtures.ISSUER,
        name: "CKB Academy",
        type: "SCHOOL",
      },
      holder: {
        address: HOLDER_A,
        recipientAddress: HOLDER_A,
      },
    });
  });

  it("follows the chain on transfer while issuer and recipient stay fixed", () => {
    // applyChainState is the only path the verification service writes through,
    // so this is exactly what a transfer reconciled from the live cell looks like.
    const record = create({ recipientAddress: HOLDER_A });
    const transferred = ctx.repositories.credentials.applyChainState(record.id, {
      status: "active",
      ownerAddress: HOLDER_B,
    });

    const { issuer, holder } = credentialActors(transferred!);

    expect(holder.address).toBe(HOLDER_B);
    expect(holder.recipientAddress).toBe(HOLDER_A);
    expect(issuer).toEqual({
      address: fixtures.ISSUER,
      name: "CKB Academy",
      type: "SCHOOL",
    });
  });

  it("keeps the last holder visible after a melt", () => {
    // A melt destroys the cell, not the history: the credential stops existing
    // on chain, but the record still says who held it.
    const record = create({ recipientAddress: HOLDER_A });
    const melted = ctx.repositories.credentials.applyChainState(record.id, {
      status: "melted",
    });

    expect(credentialActors(melted!).holder.address).toBe(HOLDER_A);
  });

  it("is a projection: mutating the view cannot touch the record", () => {
    const record = create({ recipientAddress: HOLDER_A });
    const actors = credentialActors(record);

    actors.issuer.address = HOLDER_B;
    actors.holder.address = HOLDER_B;
    actors.holder.recipientAddress = HOLDER_B;

    expect(record.issuerAddress).toBe(fixtures.ISSUER);
    expect(record.ownerAddress).toBe(HOLDER_A);
    expect(record.recipientAddress).toBe(HOLDER_A);
  });
});
