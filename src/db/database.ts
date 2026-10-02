import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { logger } from "../utils/logger.js";

export type SqliteDatabase = Database.Database;

const MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: "001-initial-schema",
    sql: `
      CREATE TABLE IF NOT EXISTS credentials (
        id                TEXT PRIMARY KEY,
        spore_id          TEXT NOT NULL UNIQUE,
        title             TEXT NOT NULL,
        description       TEXT NOT NULL DEFAULT '',
        issuer_name       TEXT NOT NULL,
        issuer_type       TEXT NOT NULL DEFAULT 'OTHER',
        issuer_address    TEXT NOT NULL,
        recipient_address TEXT NOT NULL,
        owner_address     TEXT NOT NULL,
        credential_type   TEXT NOT NULL,
        issue_date        TEXT NOT NULL,
        expiration_date   TEXT,
        creation_tx_hash  TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending',
        network           TEXT NOT NULL DEFAULT 'testnet',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_credentials_owner
        ON credentials (owner_address);
      CREATE INDEX IF NOT EXISTS idx_credentials_recipient
        ON credentials (recipient_address);
      CREATE INDEX IF NOT EXISTS idx_credentials_issuer
        ON credentials (issuer_address);
      CREATE INDEX IF NOT EXISTS idx_credentials_status
        ON credentials (status);
      CREATE INDEX IF NOT EXISTS idx_credentials_updated
        ON credentials (updated_at DESC);

      CREATE TABLE IF NOT EXISTS transactions (
        id           TEXT PRIMARY KEY,
        tx_hash      TEXT NOT NULL UNIQUE,
        credential_id TEXT REFERENCES credentials (id) ON DELETE CASCADE,
        spore_id     TEXT,
        type         TEXT NOT NULL,
        status       TEXT NOT NULL,
        block_number TEXT,
        detail       TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_credential
        ON transactions (credential_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_created
        ON transactions (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_status
        ON transactions (status);
    `,
  },
  {
    id: "002-users-auth-sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_address    TEXT NOT NULL UNIQUE,
        display_name      TEXT,
        avatar_url        TEXT,
        bio               TEXT,
        organization_name TEXT,
        organization_type TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        last_login_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_nonces (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_address TEXT NOT NULL,
        nonce          TEXT NOT NULL UNIQUE,
        message        TEXT NOT NULL,
        expires_at     TEXT NOT NULL,
        used_at        TEXT,
        created_at     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_nonces_wallet
        ON auth_nonces (wallet_address);
      CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires
        ON auth_nonces (expires_at);

      CREATE TABLE IF NOT EXISTS sessions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_hash TEXT NOT NULL UNIQUE,
        user_id      INTEGER NOT NULL,
        expires_at   TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions (user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires
        ON sessions (expires_at);
    `,
  },
];

/**
 * Thin wrapper around `better-sqlite3`.
 *
 * The repository layer only ever talks to this object, so swapping SQLite for
 * another relational store means reimplementing one file - not the services.
 */
export class AppDatabase {
  private constructor(
    readonly raw: SqliteDatabase,
    readonly location: string,
  ) {}

  static open(file: string, options: { readonly?: boolean } = {}): AppDatabase {
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }

    const raw = new Database(file, {
      readonly: options.readonly ?? false,
    });
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    raw.pragma("busy_timeout = 5000");

    return new AppDatabase(raw, file);
  }

  /** Applies pending migrations. Safe to call on every boot. */
  migrate(): void {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );

    const applied = new Set(
      this.raw
        .prepare<[], { id: string }>("SELECT id FROM schema_migrations")
        .all()
        .map((row) => row.id),
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;

      const run = this.raw.transaction(() => {
        this.raw.exec(migration.sql);
        this.raw
          .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, new Date().toISOString());
      });
      run();
      logger.info(`Applied database migration ${migration.id}`);
    }
  }

  /**
   * Removes every application row (used by `npm run db:reset` and tests).
   *
   * Sessions and nonces go first because they reference `users` through a
   * foreign key.
   */
  truncate(): void {
    this.raw.exec(
      "DELETE FROM transactions; DELETE FROM credentials; DELETE FROM sessions; DELETE FROM auth_nonces; DELETE FROM users;",
    );
  }

  close(): void {
    this.raw.close();
  }
}
