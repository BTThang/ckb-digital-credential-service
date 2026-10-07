/**
 * Shared domain types for the CKB Digital Credential service.
 *
 * IMPORTANT: the database is an *index* / cache only. Ownership, existence and
 * transaction status are always read from the CKB node. See docs/architecture.md.
 *
 * The `users` / `auth_nonces` / `sessions` tables below are different in kind:
 * they are application state, not a cache of anything. They are still not
 * authoritative about *credentials* - CKB remains the only source of truth for
 * who owns a credential.
 */

export const CREDENTIAL_TYPES = [
  "COURSE_COMPLETION",
  "SKILL_ACHIEVEMENT",
  "EVENT_PARTICIPATION",
  "PROFESSIONAL_CERTIFICATION",
  "OTHER",
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const ISSUER_TYPES = [
  "COMPANY",
  "SCHOOL",
  "EVENT_ORGANIZER",
  "PROFESSIONAL_ORGANIZATION",
  "OTHER",
] as const;

export type IssuerType = (typeof ISSUER_TYPES)[number];

/**
 * Off-chain index status. It is deliberately NOT a verification result:
 * `pending` means the creation transaction has not been committed yet.
 *
 * Lifecycle mapping (docs/domain-model.md#3-credential-lifecycle):
 * `pending` = ISSUED, `active` = ACTIVE (a transfer keeps it `active` and only
 * moves `ownerAddress`), `melted` = REVOKED/MELTED, `unknown` = the node could
 * not be queried, which is an infrastructure state and never a credential one.
 */
export const CREDENTIAL_STATUSES = [
  "pending",
  "active",
  "melted",
  "unknown",
] as const;

export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const TRANSACTION_TYPES = [
  "CREATE_CREDENTIAL",
  "TRANSFER_CREDENTIAL",
  "MELT_CREDENTIAL",
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = [
  "submitted",
  "pending",
  "committed",
  "failed",
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/**
 * Result of a blockchain-authoritative verification.
 *
 * - `verified`        the spore exists on chain and was decoded
 * - `not_found`       no live spore cell for that id (never created, or melted)
 * - `unable_to_verify` the RPC node / decoder failed, so we cannot conclude
 */
export const VERIFICATION_STATES = [
  "verified",
  "not_found",
  "unable_to_verify",
] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];

/** Raw CKB transaction status as reported by the node. */
export type CkbTransactionStatus =
  | "sent"
  | "pending"
  | "proposed"
  | "committed"
  | "unknown"
  | "rejected";

export interface CredentialRecord {
  id: string;
  sporeId: string;
  title: string;
  description: string;
  issuerName: string;
  issuerType: IssuerType;
  issuerAddress: string;
  recipientAddress: string;
  ownerAddress: string;
  credentialType: CredentialType;
  issueDate: string;
  expirationDate: string | null;
  creationTxHash: string;
  status: CredentialStatus;
  network: string;
  createdAt: string;
  updatedAt: string;
}

// The three parties in the credential model are roles a credential *has*, not
// account types: one address can be the issuer of one credential and the
// holder of another, and issuing to yourself is legal.
// See docs/domain-model.md.

/** Who wrote the credential. From the issuer's request; compared with, never corrected by, the chain. */
export interface Issuer {
  address: string;
  name: string;
  type: IssuerType;
}

/**
 * Who owns the credential.
 *
 * `ownerAddress` (the current holder) is the address behind the live Spore
 * cell's lock script and is written to the index only from a chain read, so it
 * follows the credential into any wallet that receives it. `recipientAddress`
 * is who it was issued to and never changes on transfer.
 */
export interface Holder {
  /** Current owner, chain-authoritative. */
  address: string;
  /** Original recipient, fixed at issue. */
  recipientAddress: string;
}

/**
 * Issuer and holder projected from an indexed record.
 *
 * The verifier is deliberately absent: a verifier never authenticates, so
 * there is no identity to project and no session to remember.
 */
export interface CredentialActors {
  issuer: Issuer;
  holder: Holder;
}

/** View a cached record through the actor roles. Pure projection — the record stays the only representation. */
export function credentialActors(record: CredentialRecord): CredentialActors {
  return {
    issuer: {
      address: record.issuerAddress,
      name: record.issuerName,
      type: record.issuerType,
    },
    holder: {
      address: record.ownerAddress,
      recipientAddress: record.recipientAddress,
    },
  };
}

export interface TransactionRecord {
  id: string;
  txHash: string;
  credentialId: string | null;
  sporeId: string | null;
  type: TransactionType;
  status: TransactionStatus;
  blockNumber: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Decoded credential payload as stored inside the Spore cell data. */
export interface SporeCredentialPayload {
  /** Schema version, bumped when the on-chain shape changes. */
  version: 1;
  title: string;
  description: string;
  issuerName: string;
  issuerType: IssuerType;
  credentialType: CredentialType;
  issueDate: string;
  expirationDate: string | null;
  network: string;
}

export interface SporeVerificationResult {
  state: VerificationState;
  sporeId: string;
  network: string;
  checkedAt: string;
  /** Present when the spore cell is live on chain. */
  sporeExists: boolean;
  currentOwner: string | null;
  ownerLock: string | null;
  contentType: string | null;
  content: SporeCredentialPayload | null;
  rawContent: string | null;
  clusterId: string | null;
  creationTxHash: string;
  creationTxStatus: CkbTransactionStatus | null;
  blockNumber: string | null;
  capacity: string | null;
  /** Why the spore could not be confirmed, when the state is not `verified`. */
  reason: string | null;
}

// ---- Public verification (GET /api/verify/:credentialId) ----

/**
 * The verdict a third party sees.
 *
 * Derived from a `VerificationState` plus the credential-level validity rules,
 * and deliberately narrower than `VerificationState`: `active` and `invalid`
 * are conclusions about the credential, `not_found` says the cell is gone, and
 * `unable_to_verify` is carried through unchanged so an infrastructure failure
 * can never be read as a credential verdict (spec Phase 2/3).
 */
export const PUBLIC_VERIFICATION_STATES = [
  "active",
  "invalid",
  "not_found",
  "unable_to_verify",
] as const;

export type PublicVerificationState = (typeof PUBLIC_VERIFICATION_STATES)[number];

/** Credential facts, all read from the cell payload. `null` when there is no live cell. */
export interface PublicVerificationCredential {
  /** The Spore id — the credential's stable identity across transfers. */
  id: string;
  title: string | null;
  type: CredentialType | null;
  issuer: { name: string; type: IssuerType | null } | null;
  /** Current owner from the live cell's lock; this is what a transfer changes. */
  holder: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
}

/** Chain facts. `status` mirrors the lifecycle: a transfer keeps it `active`. */
export interface PublicVerificationBlockchain {
  network: string;
  status: "active" | "not_found" | "unknown";
  sporeId: string;
  currentOwner: string | null;
  creationTxHash: string | null;
}

/**
 * The public verification envelope. Carries no session, user, index or
 * database fields: everything in it was read from CKB.
 */
export interface PublicVerification {
  valid: boolean;
  state: PublicVerificationState;
  /** Always "ckb": there is no second source that could answer this. */
  source: "ckb";
  reason: string | null;
  checkedAt: string;
  credential: PublicVerificationCredential | null;
  blockchain: PublicVerificationBlockchain;
}

export interface TransactionChainInfo {
  txHash: string;
  found: boolean;
  status: CkbTransactionStatus | null;
  blockNumber: string | null;
  blockHash: string | null;
  reason: string | null;
  error: string | null;
  inputCount: number | null;
  outputCount: number | null;
}

/**
 * Kind of organization a credential issuer belongs to.
 *
 * `other` is a deliberate value rather than a null: a user who declines to
 * classify themselves should not be forced into a wrong bucket, and the list is
 * expected to grow (nft_community, government, media, ...) without a migration.
 */
export const ORGANIZATION_TYPES = [
  "company",
  "school",
  "training_center",
  "event_organizer",
  "professional_organization",
  "nonprofit",
  "other",
] as const;

export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

/**
 * Application identity.
 *
 * `walletAddress` is the external identity: it is UNIQUE in the database and is
 * proven by a signature challenge, never by anything the browser asserts. Every
 * other field is self-declared profile data that the user may edit freely.
 */
export interface UserRecord {
  id: number;
  walletAddress: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  organizationName: string | null;
  organizationType: OrganizationType | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

/**
 * A one-time sign-in challenge, bound to a wallet address.
 *
 * The nonce is only ever handed to the client *inside* `message`, so there is
 * nothing to steal that the signature does not already cover.
 */
export interface AuthNonceRecord {
  id: number;
  walletAddress: string;
  nonce: string;
  message: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

/**
 * A server-side session.
 *
 * `sessionHash` is the SHA-256 of the opaque cookie token. The raw token exists
 * only in the browser cookie and in the response that set it, so a leaked
 * database dump cannot be replayed as a login.
 */
export interface SessionRecord {
  id: number;
  sessionHash: string;
  userId: number;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string | null;
}

/** The public shape of a user. Never includes the wallet's secrets or a token. */
export interface PublicUser {
  id: number;
  walletAddress: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  organizationName: string | null;
  organizationType: OrganizationType | null;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    walletAddress: user.walletAddress,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    organizationName: user.organizationName,
    organizationType: user.organizationType,
  };
}
