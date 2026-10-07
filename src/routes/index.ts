import { Router } from "express";

import type { AppContext } from "../context.js";
import { createAuthRouter } from "./auth.routes.js";
import {
  createCredentialRouter,
  createSporeRouter,
} from "./credential.routes.js";
import { createHealthRouter } from "./health.routes.js";
import { createProfileRouter } from "./profile.routes.js";
import { createTransactionRouter } from "./transaction.routes.js";
import { createVerifyRouter } from "./verify.routes.js";

export function createApiRouter(context: AppContext): Router {
  const router = Router();
  const cookieName = context.auth.cookieName;

  router.use("/health", createHealthRouter(context.healthDeps));
  router.use(
    "/credentials",
    createCredentialRouter({
      credentials: context.services.credentials,
      verification: context.services.verification,
      spores: context.services.spores,
      transactions: context.services.ckbTransactions,
    }),
  );
  router.use(
    "/spores",
    createSporeRouter({
      credentials: context.services.credentials,
      verification: context.services.verification,
      spores: context.services.spores,
      transactions: context.services.ckbTransactions,
    }),
  );
  router.use(
    "/verify",
    createVerifyRouter({
      credentials: context.services.credentials,
      verification: context.services.verification,
      spores: context.services.spores,
      transactions: context.services.ckbTransactions,
    }),
  );
  router.use(
    "/transactions",
    createTransactionRouter({
      repositories: context.repositories,
      ckbTransactions: context.services.ckbTransactions,
    }),
  );
  router.use(
    "/auth",
    createAuthRouter({
      auth: context.services.auth,
      sessions: context.services.sessions,
      env: context.env,
    }),
  );
  router.use(
    "/profile",
    createProfileRouter({
      users: context.services.users,
      sessions: context.services.sessions,
      cookieName,
    }),
  );

  return router;
}