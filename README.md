# CKB Digital Credential — Service

Read-only HTTP API for the CKB Digital Credential dApp. It indexes credentials
and tracks transactions so the UI can list and filter them, but **it is never
the source of truth**: ownership and existence are always read back from the
CKB node.

The service holds no keys and signs nothing. Every write path (issue, transfer,
melt) happens in the browser behind the user's wallet.

## Requirements

- Node.js >= 20.11
- A CKB node (public testnet/mainnet endpoints are built in)

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

The API listens on `http://127.0.0.1:3000` by default.

## Scripts

| Script              | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Watch mode via `tsx`                            |
| `npm run build`     | Compile to `dist/`                              |
| `npm start`         | Run the compiled build                          |
| `npm test`          | Vitest (unit + HTTP integration)                |
| `npm run typecheck` | `tsc --noEmit`                                  |
| `npm run lint`      | ESLint                                          |
| `npm run db:reset`  | Drop every row in the local SQLite index        |

## Environment

| Variable        | Default                 | Notes                                              |
| --------------- | ----------------------- | -------------------------------------------------- |
| `PORT`          | `3000`                  |                                                     |
| `HOST`          | `127.0.0.1`             |                                                     |
| `CORS_ORIGIN`   | `http://localhost:5173` | Comma-separated list                                |
| `CKB_NETWORK`   | `testnet`               | `testnet` \| `mainnet`                              |
| `CKB_RPC_URL`   | _(CCC defaults)_        | Comma-separated; falls back to public endpoints     |
| `DATABASE_FILE` | `./data/credentials.db` | Relative paths resolve from the project root         |
| `LOG_LEVEL`     | `info`                  | `error` \| `warn` \| `info` \| `debug`              |

## API

All responses are JSON. Success bodies are wrapped in `data`; errors use
`{ "error": { "code", "message", "details? } }`.

### Health

`GET /api/health`

Reports API liveness plus a best-effort CKB probe. `chain.reachable: false`
means the node could not be reached — it is not an outage of this service.

### Credentials

| Method   | Path                        | Purpose                                              |
| -------- | --------------------------- | ---------------------------------------------------- |
| `GET`    | `/api/credentials`          | Paginated list. Filters: `owner`, `recipient`, `issuer`, `issuerName`, `status`, `type`, `search` |
| `POST`   | `/api/credentials`          | Index a credential the client already broadcast      |
| `POST`   | `/api/credentials/sync`     | Re-read every indexed credential from the chain      |
| `GET`    | `/api/credentials/:id`      | Read one index entry                                 |
| `PATCH`  | `/api/credentials/:id`      | Edit display metadata (never status or ownership)    |
| `DELETE` | `/api/credentials/:id`      | Remove the index entry; the Spore itself is untouched |
| `GET`    | `/api/credentials/:id/verify` | Blockchain-authoritative verification             |

A `sporeId` is the Spore's own id: **32 bytes of hex** (`0x` + 64 hex chars),
taken from the cell's type script args. It is *not* a cell outpoint and *not* a
transaction hash — anything that is not exactly 66 characters is rejected with
`400`.

Because the id is `hashTypeId(firstInput, outputIndex)` rather than a copy of
those two values, the creation transaction **cannot** be recovered from it. The
service reads the creation hash from the live cell's out point instead.

### Spores

| Method | Path                              | Purpose                                          |
| ------ | --------------------------------- | ------------------------------------------------ |
| `GET`  | `/api/spores/lookup?sporeId=…`    | Index entry for a spore id, or `null`             |
| `GET`  | `/api/spores/owner/:address`      | Live Spores owned by an address                  |
| `GET`  | `/api/spores/:sporeId/verify`     | Verify without any index entry                   |

### Transactions

| Method | Path                        | Purpose                                       |
| ------ | --------------------------- | --------------------------------------------- |
| `GET`  | `/api/transactions`         | Paginated tracking list                        |
| `POST` | `/api/transactions`         | Idempotent upsert, keyed on `txHash`           |
| `GET`  | `/api/transactions/:txHash` | Chain state merged with the cached row         |

`GET /api/transactions/:txHash` returns `404` only when the node has never seen
the hash **and** nothing is tracked locally. If the RPC is unreachable it
returns `503`, so "failed" is never reported for a node outage.

## The three verification states

`state` is derived exclusively from the chain:

| State              | Meaning                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `verified`         | A live Spore cell exists and its payload decodes. Ownership is read from the cell's lock script. |
| `not_found`        | The creation tx is unknown/uncommitted, or the cell is gone (melted).    |
| `unable_to_verify` | The node or the decoder failed. **No conclusion is drawn.**              |

`indexed` in the response reports the cache *before* the check, so the UI can
show how far the local index had drifted. A credential is `reconciled: true`
when the chain state differed from what was stored.

```jsonc
{
  "data": {
    "state": "verified",
    "verification": {
      "sporeExists": true,
      "currentOwner": "ckt1q…",
      "ownerLock": "0x…",
      "creationTxHash": "0x…",
      "creationTxStatus": "committed",
      "blockNumber": "22574278"
    },
    "indexed": {
      "statusInDatabase": "pending",
      "ownerInDatabase": "ckt1q…",
      "ownerMatchesChain": false,
      "metadataMatchesChain": true,
      "mismatchedFields": [],
      "reconciled": true
    }
  }
}
```

## Data model

The on-chain payload is a JSON document stored in the Spore cell:

```jsonc
{
  "version": 1,
  "title": "Advanced TypeScript",
  "description": "Completed the advanced TypeScript course",
  "issuerName": "CKB Academy",
  "issuerType": "SCHOOL",
  "credentialType": "COURSE_COMPLETION",
  "issueDate": "2026-01-15",
  "expirationDate": null,
  "network": "testnet"
}
```

- `credentialType`: `COURSE_COMPLETION`, `SKILL_ACHIEVEMENT`, `EVENT_PARTICIPATION`, `PROFESSIONAL_CERTIFICATION`, `OTHER`
- `issuerType`: `COMPANY`, `SCHOOL`, `EVENT_ORGANIZER`, `PROFESSIONAL_ORGANIZATION`, `OTHER`
- `status`: `pending`, `active`, `melted`, `unknown`

The SQLite index adds `issuerAddress`, `recipientAddress`, `ownerAddress` and
`creationTxHash`. Only `ownerAddress` and `status` are ever written by the
verification path — everything else comes from the issuer's request.

## Architecture

```
routes -> controllers -> services -> repositories -> SQLite
                          |
                          +--> CkbTransactionService / SporeService --> CKB RPC
```

- `src/context.ts` — composition root; builds the whole object graph once
- `src/services/verification.service.ts` — the only place a verification state is decided
- `src/repositories/` — all SQL lives here
- `src/models/` — table row shapes, column lists, and row→domain mappers
- `src/db/database.ts` — thin `better-sqlite3` wrapper plus migrations

`src/models/` is deliberately the only place that knows about column names.
Repositories prepare parameters and call a mapper; anything that would otherwise
`as`-cast a raw row into a `CredentialRecord` is a `coerce*` function that maps
an unrecognised enum value to a safe default (`OTHER`, `unknown`, `pending`)
instead. A value the running code does not understand then degrades to "unknown"
rather than corrupting a record that was already valid.

Tests build an in-memory database and a stub CKB client, which is why nothing
in the test suite touches the network.

## Notes on the CKB client

- The client is opened with `ccc.ClientPublicTestnet.open()` / `openMainnet()`,
  not the deprecated `new ccc.ClientPublicTestnet()`.
- Read-only by construction: no signer is ever created here.
- `spore.findSpores` can fail on historical Spores that the current decoder
  cannot read. `findSporesByOwner` catches this and returns what it has rather
  than failing the whole request.
