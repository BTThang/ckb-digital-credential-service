import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { createAppContext, type AppContext } from "../context.js";
import { AppDatabase } from "../db/database.js";
import { WalletIdentityService } from "../services/wallet-identity.service.js";
import type { SignatureInput } from "../validation/auth.schema.js";
import { createTestEnv } from "./env-fixture.js";
import {
  createFakeCkbClient,
  createTestWallet,
  signChallenge,
  type TestWallet,
} from "./ckb-fixture.js";

interface Envelope<T> {
  data: T;
  error?: { code: string; message: string };
}

interface SessionUser {
  id: number;
  walletAddress: string;
  displayName: string | null;
  bio: string | null;
  lastLoginAt: string | null;
}

describe("wallet authentication", () => {
  let server: Server;
  let base: string;
  let context: AppContext;
  let alice: TestWallet;
  let mallory: TestWallet;

  async function api<T = any>(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: Envelope<T>; cookie?: string }> {
    const response = await fetch(`${base}${path}`, init);
    const setCookie = response.headers.get("set-cookie") ?? undefined;

    return {
      status: response.status,
      body: (await response.json()) as Envelope<T>,
      ...(setCookie ? { cookie: setCookie } : {}),
    };
  }

  const post = (payload: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const patch = (payload: unknown): RequestInit => ({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  /** Merges the session cookie into a JSON request without losing either header. */
  const patchWith = (cookie: string, payload: unknown): RequestInit => ({
    ...patch(payload),
    headers: { "Content-Type": "application/json", Cookie: cookie },
  });

  const withCookie = (cookie: string): RequestInit => ({
    headers: { Cookie: cookie },
  });

  /** Requests a challenge and returns the exact message the server stored. */
  async function challenge(address: string): Promise<string> {
    const { status, body } = await api<{ message: string }>(
      "/api/auth/nonce",
      post({ address }),
    );
    expect(status).toBe(200);
    return body.data.message;
  }

  /** Runs the full happy path and hands back the session cookie. */
  async function signIn(wallet: TestWallet): Promise<string> {
    const message = await challenge(wallet.address);
    const { status, cookie } = await api<{ user: SessionUser }>(
      "/api/auth/verify",
      post({
        address: wallet.address,
        message,
        signature: await signChallenge(wallet, message),
      }),
    );

    expect(status).toBe(200);
    expect(cookie).toBeDefined();
    return cookie!.split(";")[0]!;
  }

  beforeAll(async () => {
    const database = AppDatabase.open(":memory:");
    database.migrate();

    const env = createTestEnv({
      auth: {
        appName: "CKB Digital Credential",
        nonceTtlMs: 5 * 60_000,
        sessionTtlMs: 60 * 60_000,
        joyIdCredentialServerUrl: "https://credentials.example.test",
        cookie: {
          name: "ckb_session",
          secure: false,
          sameSite: "strict",
          path: "/",
        },
      },
    });

    context = createAppContext({
      env,
      network: "testnet",
      database,
      ckbClient: createFakeCkbClient(),
    });

    alice = await createTestWallet(0x11);
    mallory = await createTestWallet(0x22);

    const app = createApp(env, context);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await context.dispose();
  });

  it("issues a challenge that names the address and a single-use nonce", async () => {
    const { status, body } = await api<{ message: string; expiresAt: string }>(
      "/api/auth/nonce",
      post({ address: alice.address }),
    );

    expect(status).toBe(200);
    expect(body.data.message).toContain(alice.address);
    expect(body.data.message).toContain("Nonce:");
    expect(Date.parse(body.data.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("signs a wallet in and stores only a hash of the session token", async () => {
    const cookie = await signIn(alice);
    const token = decodeURIComponent(cookie.split("=")[1]!);

    const row = context.db.raw
      .prepare<[], { session_hash: string }>("SELECT session_hash FROM sessions")
      .all()
      .find((entry) => entry.session_hash === createHash("sha256").update(token).digest("hex"));

    expect(row).toBeDefined();
    // The usable token must never be recoverable from the database.
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("never returns the raw session token in the response body", async () => {
    const message = await challenge(alice.address);
    const { body } = await api("/api/auth/verify", {
      ...post({
        address: alice.address,
        message,
        signature: await signChallenge(alice, message),
      }),
    });

    expect(JSON.stringify(body)).not.toMatch(/sessionHash|session_hash|token/i);
  });

  it("marks the cookie HttpOnly and SameSite=Strict", async () => {
    const message = await challenge(alice.address);
    const { cookie } = await api("/api/auth/verify", {
      ...post({
        address: alice.address,
        message,
        signature: await signChallenge(alice, message),
      }),
    });

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("restores the session from the cookie and reports anonymous without one", async () => {
    const cookie = await signIn(alice);

    const signedIn = await api<{ authenticated: boolean; user: SessionUser }>(
      "/api/auth/me",
      withCookie(cookie),
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.authenticated).toBe(true);
    expect(signedIn.body.data.user.walletAddress).toBe(alice.address);

    // Not being signed in is a normal state, so it is a 200 - not a 401.
    const anonymous = await api<{ authenticated: boolean }>("/api/auth/me");
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.data.authenticated).toBe(false);
  });

  it("refuses to reuse a challenge that already signed someone in", async () => {
    const message = await challenge(alice.address);
    const signature = await signChallenge(alice, message);
    const payload = { address: alice.address, message, signature };

    const first = await api("/api/auth/verify", post(payload));
    expect(first.status).toBe(200);

    const replay = await api("/api/auth/verify", post(payload));
    expect(replay.status).toBe(401);
    expect(replay.body.error!.code).toBe("UNAUTHORIZED");
  });

  it("refuses a message that differs from the stored challenge by a byte", async () => {
    const message = await challenge(alice.address);
    const tampered = `${message} `;
    const { status } = await api(
      "/api/auth/verify",
      post({
        address: alice.address,
        message: tampered,
        signature: await signChallenge(alice, tampered),
      }),
    );

    expect(status).toBe(401);
  });

  /**
   * The impersonation guard, and the reason this whole file exists: a
   * perfectly valid signature is not enough. Mallory can ask for a challenge
   * naming Alice's address and sign it with her own key, so the signature has
   * to be tied back to the address before a session is issued.
   */
  it("refuses a valid signature made with someone else's key", async () => {
    const message = await challenge(alice.address);
    const { status, body } = await api(
      "/api/auth/verify",
      post({
        address: alice.address,
        message,
        // Mallory's key, over Alice's challenge.
        signature: await signChallenge(mallory, message),
      }),
    );

    expect(status).toBe(401);
    expect(body.error!.code).toBe("UNAUTHORIZED");
  });

  it("refuses a challenge requested for one address but claimed for another", async () => {
    const message = await challenge(alice.address);
    const { status } = await api(
      "/api/auth/verify",
      post({
        address: mallory.address,
        message,
        signature: await signChallenge(alice, message),
      }),
    );

    expect(status).toBe(401);
  });

  it("refuses a signature whose identity is not a public key", async () => {
    const message = await challenge(alice.address);
    const signature = await signChallenge(alice, message);
    const { status } = await api(
      "/api/auth/verify",
      post({
        address: alice.address,
        message,
        signature: { ...signature, identity: alice.address },
      }),
    );

    expect(status).toBe(401);
  });

  it("refuses an expired challenge", async () => {
    const message = await challenge(alice.address);
    const nonce = context.repositories.auth.findNonceByMessage(message)!;

    // Backdate the stored challenge instead of waiting out the TTL.
    context.db.raw
      .prepare("UPDATE auth_nonces SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), nonce.id);

    const { status } = await api(
      "/api/auth/verify",
      post({
        address: alice.address,
        message,
        signature: await signChallenge(alice, message),
      }),
    );

    expect(status).toBe(401);
  });

  it("refuses a sign type that cannot be tied to a CKB address", async () => {
    const message = await challenge(alice.address);
    const { status, body } = await api(
      "/api/auth/verify",
      post({
        address: alice.address,
        message,
        signature: {
          ...(await signChallenge(alice, message)),
          signType: "EvmPersonal",
        },
      }),
    );

    expect(status).toBe(400);
    expect(body.error!.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a mainnet address on a testnet deployment", async () => {
    const mainnet = await createTestWallet(0x33, "ckb");
    const message = await challenge(mainnet.address);

    const { status } = await api(
      "/api/auth/verify",
      post({
        address: mainnet.address,
        message,
        signature: await signChallenge(mainnet, message),
      }),
    );

    expect(status).toBe(401);
  });

  it("revokes the session on logout, so the cookie stops working", async () => {
    const cookie = await signIn(alice);

    const loggedOut = await api("/api/auth/logout", {
      ...withCookie(cookie),
      method: "POST",
    });
    expect(loggedOut.status).toBe(200);

    const replayed = await api<{ authenticated: boolean }>(
      "/api/auth/me",
      withCookie(cookie),
    );
    expect(replayed.body.data.authenticated).toBe(false);
  });

  it("requires a session for the profile endpoints", async () => {
    const read = await api("/api/profile");
    expect(read.status).toBe(401);

    const write = await api("/api/profile", patch({ displayName: "Nope" }));
    expect(write.status).toBe(401);
  });

  it("updates only the profile fields that were sent", async () => {
    const cookie = await signIn(alice);

    const seeded = await api<{ user: SessionUser & { bio: string } }>(
      "/api/profile",
      patchWith(cookie, {
        displayName: "Alice",
        bio: "CKB enthusiast",
        organizationName: "CKB Academy",
        organizationType: "school",
      }),
    );
    expect(seeded.status).toBe(200);
    expect(seeded.body.data.user.bio).toBe("CKB enthusiast");

    // A one-field PATCH must not erase the rest of the profile.
    const single = await api<{ user: SessionUser & { bio: string } }>(
      "/api/profile",
      patchWith(cookie, { displayName: "Alice A." }),
    );
    expect(single.status).toBe(200);
    expect(single.body.data.user.displayName).toBe("Alice A.");
    expect(single.body.data.user.bio).toBe("CKB enthusiast");
  });

  it("clears a field that is explicitly sent as an empty string", async () => {
    const cookie = await signIn(alice);

    await api("/api/profile", patchWith(cookie, { bio: "Something" }));

    const { status, body } = await api<{ user: SessionUser }>(
      "/api/profile",
      patchWith(cookie, { bio: "" }),
    );

    expect(status).toBe(200);
    expect(body.data.user.bio).toBeNull();
  });

  it("refuses a profile patch that tries to name a user or an immutable column", async () => {
    const cookie = await signIn(alice);

    for (const body of [
      { userId: 1 },
      { walletAddress: mallory.address },
      { id: 1 },
      { createdAt: "2020-01-01T00:00:00.000Z" },
      {},
    ]) {
      const { status } = await api("/api/profile", patchWith(cookie, body));
      expect(status).toBe(400);
    }
  });
});

describe("WalletIdentityService", () => {
  const env = createTestEnv({
    auth: {
      appName: "CKB Digital Credential",
      nonceTtlMs: 5 * 60_000,
      sessionTtlMs: 60 * 60_000,
      joyIdCredentialServerUrl: "https://credentials.example.test",
      cookie: { name: "ckb_session", secure: false, sameSite: "strict", path: "/" },
    },
  });

  const secpSignature = async (
    wallet: TestWallet,
  ): Promise<SignatureInput> => signChallenge(wallet, "challenge");

  it("accepts a secp256k1 key that derives the claimed address", async () => {
    const wallet = await createTestWallet(0x44);
    const service = new WalletIdentityService(env);

    await expect(
      service.assertBoundToAddress(
        await secpSignature(wallet),
        wallet.address,
      ),
    ).resolves.toBeUndefined();
  });

  it("accepts a secp256k1 identity with or without the 0x prefix", async () => {
    const wallet = await createTestWallet(0x55);
    const service = new WalletIdentityService(env);
    const signature = await secpSignature(wallet);

    await expect(
      service.assertBoundToAddress(
        { ...signature, identity: signature.identity.slice(2) },
        wallet.address,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a secp256k1 key that derives a different address", async () => {
    const wallet = await createTestWallet(0x66);
    const other = await createTestWallet(0x77);
    const service = new WalletIdentityService(env);

    await expect(
      service.assertBoundToAddress(
        await secpSignature(wallet),
        other.address,
      ),
    ).rejects.toThrow();
  });

  it("rejects an identity that is not a compressed public key", async () => {
    const wallet = await createTestWallet(0x88);
    const service = new WalletIdentityService(env);
    const signature = await secpSignature(wallet);

    for (const identity of ["0x1234", "not hex", "", "0x" + "ab".repeat(32)]) {
      await expect(
        service.assertBoundToAddress({ ...signature, identity }, wallet.address),
      ).rejects.toThrow();
    }
  });

  describe("JoyID", () => {
    const joyId = (publicKey: string): SignatureInput => ({
      signature: "0xdeadbeef",
      identity: JSON.stringify({ keyType: "main_key", publicKey }),
      signType: "JoyId",
    });

    it("accepts a key the JoyID registry confirms for the address", async () => {
      const service = new WalletIdentityService(env, async () => true);

      await expect(
        service.assertBoundToAddress(joyId("abc123"), "ckt1qaddress"),
      ).resolves.toBeUndefined();
    });

    it("rejects a key the registry does not list for the address", async () => {
      const service = new WalletIdentityService(env, async () => false);

      await expect(
        service.assertBoundToAddress(joyId("abc123"), "ckt1qaddress"),
      ).rejects.toThrow();
    });

    it("fails closed when the registry is unreachable", async () => {
      const service = new WalletIdentityService(env, async () => {
        throw new Error("ECONNREFUSED");
      });

      await expect(
        service.assertBoundToAddress(joyId("abc123"), "ckt1qaddress"),
      ).rejects.toThrow();
    });

    it("refuses JoyID entirely when no registry is configured", async () => {
      const service = new WalletIdentityService(
        {
          ...env,
          auth: { ...env.auth, joyIdCredentialServerUrl: undefined },
        },
        async () => true,
      );

      await expect(
        service.assertBoundToAddress(joyId("abc123"), "ckt1qaddress"),
      ).rejects.toThrow(/cannot be verified/i);
    });

    it("rejects a malformed JoyID identity without calling the registry", async () => {
      let called = false;
      const service = new WalletIdentityService(env, async () => {
        called = true;
        return true;
      });

      for (const identity of [
        "not json",
        JSON.stringify({ publicKey: "abc" }),
        JSON.stringify({ keyType: "main_key" }),
        JSON.stringify({ keyType: "unknown_key", publicKey: "abc" }),
      ]) {
        await expect(
          service.assertBoundToAddress(
            { signature: "0xdeadbeef", identity, signType: "JoyId" },
            "ckt1qaddress",
          ),
        ).rejects.toThrow();
      }

      expect(called).toBe(false);
    });
  });
});
