import { createApp } from "./app.js";
import { env } from "./config/index.js";
import { AppDatabase } from "./db/database.js";
import { createAppContext } from "./context.js";
import { CkbClientService } from "./services/ckb/client.js";
import { logger, setLogLevel } from "./utils/logger.js";

setLogLevel(env.logLevel);

const database = AppDatabase.open(env.databaseFile);
database.migrate();

const ckbClient = new CkbClientService(env.network, env.rpcUrls);
const context = createAppContext({
  env,
  network: env.network,
  database,
  ckbClient,
});

const app = createApp(env, context);

const server = app.listen(env.port, env.host, () => {
  logger.info(
    `CKB Digital Credential API listening on http://${env.host}:${env.port}`,
  );
  logger.info(`Network: ${env.network} | Database: ${database.location}`);
  logger.info(
    `Session cookie: ${env.auth.cookie.name} (secure=${env.auth.cookie.secure}, sameSite=${env.auth.cookie.sameSite})`,
  );
});

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down...`);
  server.close();
  await context.dispose();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason);
});
