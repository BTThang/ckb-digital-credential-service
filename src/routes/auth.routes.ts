import { Router } from "express";

import {
  authController,
  type AuthControllerDeps,
} from "../controllers/auth.controller.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validate } from "../middleware/validate.js";
import {
  authNonceRequestSchema,
  authVerifyRequestSchema,
} from "../validation/auth.schema.js";

/**
 * Wallet authentication.
 *
 * `/nonce` and `/verify` are deliberately unauthenticated - that is the point.
 * `/me` is authenticated but tolerant, and `/logout` works either way so a
 * client can always clear a stale cookie.
 */
export function createAuthRouter(deps: AuthControllerDeps): Router {
  const router = Router();
  const controller = authController(deps);

  router.post(
    "/nonce",
    validate(authNonceRequestSchema),
    asyncHandler(controller.requestNonce),
  );

  router.post(
    "/verify",
    validate(authVerifyRequestSchema),
    asyncHandler(controller.verify),
  );

  router.get("/me", asyncHandler(controller.me));

  router.post("/logout", asyncHandler(controller.logout));

  return router;
}