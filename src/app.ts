import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";

import type { Env } from "./config/index.js";
import type { AppContext } from "./context.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestLogger } from "./middleware/request-logger.js";
import { createApiRouter } from "./routes/index.js";

export function createApp(env: Env, context: AppContext): Express {
  const app = express();

  app.disable("x-powered-by");
  if (env.trustProxy) app.set("trust proxy", 1);

  app.use(
    helmet({
      // The API only serves JSON; CSP is handled by the frontend host.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(
    cors({
      origin: env.corsOrigins,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
      // Required for the HttpOnly session cookie to survive the cross-origin
      // dev setup. `origin` is an explicit allow-list, never `*`, because the
      // CORS spec forbids pairing a wildcard with credentials.
      credentials: true,
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use(requestLogger);

  app.use("/api", createApiRouter(context));

  app.get("/", (_req, res) => {
    res.json({
      service: "ckb-digital-credential-service",
      docs: "/api/health",
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
