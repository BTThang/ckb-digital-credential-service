import type { AppDatabase } from "../db/database.js";
import { AuthRepository } from "./auth.repository.js";
import { CredentialRepository } from "./credential.repository.js";
import { TransactionRepository } from "./transaction.repository.js";
import { UserRepository } from "./user.repository.js";

export interface Repositories {
  credentials: CredentialRepository;
  transactions: TransactionRepository;
  users: UserRepository;
  auth: AuthRepository;
}

export function createRepositories(db: AppDatabase): Repositories {
  return {
    credentials: new CredentialRepository(db),
    transactions: new TransactionRepository(db),
    users: new UserRepository(db),
    auth: new AuthRepository(db),
  };
}

export { CredentialRepository } from "./credential.repository.js";
export { TransactionRepository } from "./transaction.repository.js";
export { UserRepository } from "./user.repository.js";
export { AuthRepository } from "./auth.repository.js";