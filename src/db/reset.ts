import { env } from "../config/index.js";
import { AppDatabase } from "./database.js";
import { logger } from "../utils/logger.js";

/**
 * Drops and recreates the local SQLite database.
 * Usage: `npm run db:reset`
 */
const database = AppDatabase.open(env.databaseFile);

try {
  database.raw.exec("DROP TABLE IF EXISTS transactions;");
  database.raw.exec("DROP TABLE IF EXISTS credentials;");
  database.raw.exec("DROP TABLE IF EXISTS sessions;");
  database.raw.exec("DROP TABLE IF EXISTS auth_nonces;");
  database.raw.exec("DROP TABLE IF EXISTS users;");
  database.raw.exec("DROP TABLE IF EXISTS schema_migrations;");
  database.migrate();
  logger.info(`Database reset complete: ${database.location}`);
} finally {
  database.close();
}