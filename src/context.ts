import type { Env } from "./config/index.js";
import type { CkbNetwork } from "./config/index.js";
import type { AppDatabase } from "./db/database.js";
import { createRepositories, type Repositories } from "./repositories/index.js";
import { AuthService } from "./services/auth.service.js";
import { type CkbClientService } from "./services/ckb/client.js";
import { CkbTransactionService } from "./services/ckb/transaction.service.js";
import { SporeService } from "./services/ckb/spore.service.js";
import { CredentialService } from "./services/credential.service.js";
import { SessionService } from "./services/session.service.js";
import { UserService } from "./services/user.service.js";
import { VerificationService } from "./services/verification.service.js";
import { WalletIdentityService } from "./services/wallet-identity.service.js";

/**
 * Composition root.
 *
 * Everything the HTTP layer needs is assembled here exactly once, which is what
 * makes the app trivially testable: tests build a context with an in-memory
 * database and a stubbed CKB client.
 */
export interface AppContext {
  network: CkbNetwork;
  startedAt: Date;
  db: AppDatabase;
  env: Env;
  /** Just the cookie name, so routes do not need the whole `Env`. */
  auth: { cookieName: string };
  repositories: Repositories;
  services: {
    ckbClient: CkbClientService;
    ckbTransactions: CkbTransactionService;
    spores: SporeService;
    verification: VerificationService;
    credentials: CredentialService;
    users: UserService;
    sessions: SessionService;
    walletIdentities: WalletIdentityService;
    auth: AuthService;
  };
  healthDeps: {
    ckb: CkbClientService;
    startedAt: Date;
  };
  dispose: () => Promise<void>;
}

export function createAppContext(options: {
  env: Env;
  network: CkbNetwork;
  database: AppDatabase;
  ckbClient: CkbClientService;
  startedAt?: Date;
}): AppContext {
  const { env, network, database, ckbClient } = options;
  const startedAt = options.startedAt ?? new Date();

  const repositories = createRepositories(database);

  const ckbTransactions = new CkbTransactionService(ckbClient);
  const spores = new SporeService(ckbClient, network);
  const verification = new VerificationService(spores, network);
  const credentials = new CredentialService(
    repositories,
    verification,
    ckbTransactions,
    network,
  );

  // Authentication depends only on the database and the env, never on a CKB
  // node: a session must stay resolvable even while the RPC endpoint is down.
  const users = new UserService(repositories.users);
  const sessions = new SessionService(
    repositories.auth,
    repositories.users,
    env,
  );
  const identities = new WalletIdentityService(env);
  const auth = new AuthService(
    repositories.auth,
    users,
    sessions,
    identities,
    env,
  );

  return {
    network,
    startedAt,
    db: database,
    env,
    auth: { cookieName: env.auth.cookie.name },
    repositories,
    services: {
      ckbClient,
      ckbTransactions,
      spores,
      verification,
      credentials,
      users,
      sessions,
      walletIdentities: identities,
      auth,
    },
    healthDeps: { ckb: ckbClient, startedAt },
    dispose: async () => {
      database.close();
      await ckbClient.dispose();
    },
  };
}