import { Router } from "express";
import { z } from "zod";

import {
  credentialController,
  type CredentialControllerDeps,
} from "../controllers/credential.controller.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validate } from "../middleware/validate.js";
import {
  ckbAddressSchema,
  createCredentialSchema,
  idParamSchema,
  listCredentialsQuerySchema,
  sporeIdParamSchema,
  updateCredentialSchema,
} from "../validation/credential.schema.js";

const lookupQuerySchema = z
  .object({ sporeId: z.string().trim().min(1) })
  .strict();

const addressParamSchema = z
  .object({ address: ckbAddressSchema })
  .strict();

export function createCredentialRouter(deps: CredentialControllerDeps): Router {
  const router = Router();
  const controller = credentialController(deps);

  router.get(
    "/",
    validate(listCredentialsQuerySchema, "query"),
    asyncHandler(controller.list),
  );

  router.post(
    "/",
    validate(createCredentialSchema, "body"),
    asyncHandler(controller.create),
  );

  router.post("/sync", asyncHandler(controller.sync));

  router.get(
    "/:id",
    validate(idParamSchema, "params"),
    asyncHandler(controller.get),
  );

  router.patch(
    "/:id",
    validate(idParamSchema, "params"),
    validate(updateCredentialSchema, "body"),
    asyncHandler(controller.update),
  );

  router.delete(
    "/:id",
    validate(idParamSchema, "params"),
    asyncHandler(controller.remove),
  );

  router.get(
    "/:id/verify",
    validate(idParamSchema, "params"),
    asyncHandler(controller.verify),
  );

  return router;
}

export function createSporeRouter(deps: CredentialControllerDeps): Router {
  const router = Router();
  const controller = credentialController(deps);

  router.get(
    "/lookup",
    validate(lookupQuerySchema, "query"),
    asyncHandler(controller.lookup),
  );

  router.get(
    "/owner/:address",
    validate(addressParamSchema, "params"),
    asyncHandler(controller.listByOwner),
  );

  router.get(
    "/:sporeId/verify",
    validate(sporeIdParamSchema, "params"),
    asyncHandler(controller.verifySporeId),
  );

  return router;
}
