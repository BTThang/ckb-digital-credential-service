import { Router } from "express";

import {
  profileController,
  type ProfileControllerDeps,
} from "../controllers/profile.controller.js";
import type { SessionService } from "../services/session.service.js";
import { asyncHandler } from "../utils/async-handler.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validate } from "../middleware/validate.js";
import { updateProfileSchema } from "../validation/auth.schema.js";

export interface ProfileRouterDeps extends ProfileControllerDeps {
  sessions: SessionService;
  cookieName: string;
}

/** Both profile endpoints sit behind the session check; neither takes an id. */
export function createProfileRouter(deps: ProfileRouterDeps): Router {
  const router = Router();
  const controller = profileController(deps);
  const auth = requireAuth(deps.sessions, deps.cookieName);

  router.get("/", auth, asyncHandler(controller.get));

  router.patch(
    "/",
    auth,
    validate(updateProfileSchema),
    asyncHandler(controller.update),
  );

  return router;
}