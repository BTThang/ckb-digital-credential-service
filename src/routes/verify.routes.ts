import { Router } from "express";

import {
  credentialController,
  type CredentialControllerDeps,
} from "../controllers/credential.controller.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validate } from "../middleware/validate.js";
import { credentialIdParamSchema } from "../validation/credential.schema.js";

/**
 * The public verification API, mounted at `/api/verify`.
 *
 * Deliberately its own router rather than a child of `/credentials`: the
 * endpoint is addressed by Spore id, is reachable with no session at all, and
 * is the surface external applications integrate against. It shares the same
 * controller and verification service as the authenticated routes, so there is
 * one chain-reading path (spec Phase 3, "Shared Verification Service").
 */
export function createVerifyRouter(deps: CredentialControllerDeps): Router {
  const router = Router();
  const controller = credentialController(deps);

  router.get(
    "/:credentialId",
    validate(credentialIdParamSchema, "params"),
    asyncHandler(controller.verifyPublic),
  );

  return router;
}
