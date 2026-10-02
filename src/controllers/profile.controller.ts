import type { NextFunction, Request, Response } from "express";

import type { UserService } from "../services/user.service.js";
import { toPublicUser } from "../types/domain.js";
import type { UpdateProfileInput } from "../validation/auth.schema.js";
import { currentUser } from "../middleware/auth.middleware.js";

export interface ProfileControllerDeps {
  users: UserService;
}

export function profileController(deps: ProfileControllerDeps) {
  const { users } = deps;

  /** `GET /api/profile` - always the session's own profile, never a lookup by id. */
  function get(req: Request, res: Response, _next: NextFunction): void {
    const user = currentUser(req);
    res.json({ data: { user: toPublicUser(users.getProfile(user.id)) } });
  }

  /**
   * `PATCH /api/profile`
   *
   * The target row comes from `currentUser(req)`, i.e. from the verified
   * session. The `.strict()` request schema separately rejects any body that
   * tries to name a user, so both halves of the rule are covered: the code
   * cannot be tricked, and the request is refused loudly if it tries.
   */
  function update(req: Request, res: Response, _next: NextFunction): void {
    const user = currentUser(req);
    const patch = req.body as UpdateProfileInput;

    res.json({
      data: { user: toPublicUser(users.updateProfile(user.id, patch)) },
    });
  }

  return { get, update };
}