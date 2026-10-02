import { AppDatabase } from "../db/database.js";
import { createRepositories } from "../repositories/index.js";
import { createCredentialSchema } from "../validation/credential.schema.js";

/** A throwaway in-memory database with migrations already applied. */
export function createTestDatabase(): AppDatabase {
  const db = AppDatabase.open(":memory:");
  db.migrate();
  return db;
}

export function createTestRepositories(db = createTestDatabase()) {
  return { db, repositories: createRepositories(db) };
}

/**
 * A Spore v2 id: a bare 32-byte value (the cell's type script args), NOT an
 * outpoint. Kept distinct from `TX_HASH` so a test cannot accidentally rely on
 * the two being interchangeable.
 */
const SPORE_ID = `0x${"a".repeat(64)}`;
const TX_HASH = `0x${"b".repeat(64)}`;
const ISSUER = "ckt1qyq0000000000000000000000000000000000000";

export function validCredentialInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sporeId: SPORE_ID,
    title: "Advanced TypeScript",
    description: "Completed the advanced TypeScript course",
    issuerName: "CKB Academy",
    issuerType: "SCHOOL",
    issuerAddress: ISSUER,
    recipientAddress: ISSUER,
    credentialType: "COURSE_COMPLETION",
    issueDate: "2026-01-15",
    expirationDate: null,
    creationTxHash: TX_HASH,
    network: "testnet",
    ...overrides,
  };
}

export function parseCredentialInput(overrides: Record<string, unknown> = {}) {
  return createCredentialSchema.parse(validCredentialInput(overrides));
}

export const fixtures = { SPORE_ID, TX_HASH, ISSUER };
