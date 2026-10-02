import { Router } from "express";
import { z } from "zod";

import {
  transactionController,
  type TransactionControllerDeps,
} from "../controllers/transaction.controller.js";
import { asyncHandler } from "../utils/async-handler.js";
import { validate } from "../middleware/validate.js";
import {
  txHashParamSchema,
  upsertTransactionSchema,
} from "../validation/credential.schema.js";

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export function createTransactionRouter(
  deps: TransactionControllerDeps,
): Router {
  const router = Router();
  const controller = transactionController(deps);

  router.get("/", validate(listQuerySchema, "query"), asyncHandler(controller.list));

  router.post(
    "/",
    validate(upsertTransactionSchema, "body"),
    asyncHandler(controller.upsert),
  );

  router.get(
    "/:txHash",
    validate(txHashParamSchema, "params"),
    asyncHandler(controller.get),
  );

  return router;
}
