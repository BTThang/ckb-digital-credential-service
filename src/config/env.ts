import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { z } from "zod";

import type { SameSite } from "../utils/cookies.js";

dotenv.config();

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export const CkbNetworkSchema = z.enum(["testnet", "mainnet"]);
export type CkbNetwork = z.infer<typeof CkbNetworkSchema>;

const booleanish = z
  .string()
  .optional()
  .transform((value) => value === "true" || value === "1");

const optionalTrimmed = z
  .string()
  .optional()
  .transform((value) =>
    value && value.trim().length > 0 ? value.trim() : undefined,
  );

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  /**
   * `localhost` and `127.0.0.1` are both listed because a browser is free to
   * resolve the name to either loopback address. Whichever one it picks becomes
   * the `Origin` header, and an origin missing from this list gets no
   * `Access-Control-Allow-Origin` back - which the page can only report as
   * "Failed to fetch", since the browser hides the real reason.
   */
  CORS_ORIGIN: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173"),
  CKB_NETWORK: CkbNetworkSchema.default("testnet"),
  CKB_RPC_URL: optionalTrimmed,
  DATABASE_FILE: z.string().min(1).default("./data/credentials.db"),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  TRUST_PROXY: booleanish,

  /** Displayed in the sign-in challenge the user is asked to sign. */
  AUTH_APP_NAME: z.string().trim().min(1).max(80).default("CKB Digital Credential"),
  /** How long a sign-in challenge stays valid. */
  AUTH_NONCE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  /** How long a session cookie stays valid. */
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(43_200).default(10_080),
  SESSION_COOKIE_NAME: optionalTrimmed,
  /** Defaults to "secure in production only"; local HTTP needs it off. */
  SESSION_COOKIE_SECURE: z
    .preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["true", "false"]).optional(),
    )
    .transform((value) =>
      value === undefined ? undefined : value === "true",
    ),
  SESSION_COOKIE_SAME_SITE: z
    .enum(["strict", "lax", "none"])
    .default("strict"),
  /**
   * JoyID credential server, used to prove that a JoyID public key really
   * controls a given CKB address. There is no safe default: guessing the host
   * would mean trusting an unknown origin with the sign-in decision, so an
   * unset value simply disables JoyID sign-in.
   */
  JOYID_CREDENTIAL_SERVER_URL: optionalTrimmed,
});

export type Env = {
  nodeEnv: "development" | "production" | "test";
  port: number;
  host: string;
  corsOrigins: string[];
  network: CkbNetwork;
  rpcUrls?: string[];
  databaseFile: string;
  logLevel: "error" | "warn" | "info" | "debug";
  trustProxy: boolean;
  projectRoot: string;
  auth: {
    appName: string;
    nonceTtlMs: number;
    sessionTtlMs: number;
    joyIdCredentialServerUrl?: string;
    cookie: {
      name: string;
      secure: boolean;
      sameSite: SameSite;
      path: "/";
    };
  };
};

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        "Copy .env.example to .env and fix the values above.",
    );
  }

  const value = parsed.data;
  const corsOrigins = value.CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const databaseFile = path.isAbsolute(value.DATABASE_FILE)
    ? value.DATABASE_FILE
    : path.resolve(projectRoot, value.DATABASE_FILE);

  const secure =
    value.SESSION_COOKIE_SECURE ?? value.NODE_ENV === "production";

  // Browsers reject `SameSite=None` without `Secure`, so asking for it over
  // plain HTTP would silently produce a cookie the browser discards.
  if (value.SESSION_COOKIE_SAME_SITE === "none" && !secure) {
    throw new Error(
      "Invalid environment configuration:\n  - SESSION_COOKIE_SAME_SITE: \"none\" requires SESSION_COOKIE_SECURE=true",
    );
  }

  const cookieName =
    value.SESSION_COOKIE_NAME ??
    (secure ? "__Host-ckb_session" : "ckb_session");

  if (cookieName.startsWith("__Host-") && !secure) {
    throw new Error(
      `Invalid environment configuration:\n  - SESSION_COOKIE_NAME: the "__Host-" prefix requires SESSION_COOKIE_SECURE=true (got "${cookieName}" with a non-secure cookie)`,
    );
  }

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    corsOrigins,
    network: value.CKB_NETWORK,
    ...(value.CKB_RPC_URL
      ? { rpcUrls: value.CKB_RPC_URL.split(",").map((url) => url.trim()) }
      : {}),
    databaseFile,
    logLevel: value.LOG_LEVEL,
    trustProxy: value.TRUST_PROXY,
    projectRoot,
    auth: {
      appName: value.AUTH_APP_NAME,
      nonceTtlMs: value.AUTH_NONCE_TTL_MINUTES * 60_000,
      sessionTtlMs: value.SESSION_TTL_MINUTES * 60_000,
      ...(value.JOYID_CREDENTIAL_SERVER_URL
        ? { joyIdCredentialServerUrl: value.JOYID_CREDENTIAL_SERVER_URL }
        : {}),
      cookie: {
        name: cookieName,
        secure,
        sameSite: value.SESSION_COOKIE_SAME_SITE,
        path: "/",
      },
    },
  };
}

export const env: Env = parseEnv(process.env);

export { projectRoot };
