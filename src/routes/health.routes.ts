import { Router } from "express";

import { asyncHandler } from "../utils/async-handler.js";
import {
  healthController,
  type HealthDeps,
} from "../controllers/health.controller.js";

export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();
  router.get("/", asyncHandler(healthController(deps)));
  return router;
}
