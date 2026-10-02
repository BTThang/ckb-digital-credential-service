import type { Env } from "../config/index.js";

/** A deterministic Env for tests - never reads process.env. */
export function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    nodeEnv: "test",
    port: 0,
    host: "127.0.0.1",
    corsOrigins: ["http://localhost:5173"],
    network: "testnet",
    databaseFile: ":memory:",
    logLevel: "error",
    trustProxy: false,
    projectRoot: process.cwd(),
    auth: {
      appName: "CKB Digital Credential",
      nonceTtlMs: 5 * 60_000,
      sessionTtlMs: 60 * 60_000,
      cookie: {
        name: "ckb_session",
        // Plain HTTP in tests, so `Secure` has to stay off.
        secure: false,
        sameSite: "strict",
        path: "/",
      },
    },
    ...overrides,
  };
}