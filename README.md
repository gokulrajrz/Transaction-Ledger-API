# Confluencr — Transaction Ledger API

Repository: [gokulrajrz/Transaction-Ledger-API](https://github.com/gokulrajrz/Transaction-Ledger-API).

A PostgreSQL-backed REST API implementing the supplied **Full Stack Developer Assessment**: accounts, exact credits/debits, balances, filtered/paginated history, immutable ledger entries and the atomic money-transfer bonus.

The implementation uses Node.js 24, strict TypeScript, Fastify 5, Zod 4 and `pg`. It uses SQL directly, with no ORM. Supabase is the intended hosted PostgreSQL provider. Per the requested local-verification scope, hosted Supabase connectivity and remote migration application remain **UNVERIFIED**. All automated financial correctness checks run against a real disposable PostgreSQL 17 server, not mocks or an in-memory substitute.

## Quick start: no database account required

Prerequisites: Node.js **24** and npm, plus a supported Linux/macOS/Windows platform for the dev-only packaged PostgreSQL binaries. Run as a regular OS user: PostgreSQL refuses root. The test helper does not create OS users or modify the host. Dependency installation requires network access and package install scripts (PostgreSQL binary symlinks and esbuild).

```bash
git clone https://github.com/gokulrajrz/Transaction-Ledger-API.git
cd Transaction-Ledger-API
nvm use                    # or install/use Node 24 with your preferred manager
npm ci
npm run dev:local
```

The last command starts real PostgreSQL on loopback with random credentials, creates a uniquely owned temporary database, applies the migrations and serves the API at `http://127.0.0.1:3000`. It ignores `.env` and `DATABASE_URL`, and refuses a configured `TEST_DATABASE_URL`. **Demo data is removed on Ctrl+C/SIGTERM.** This mode is for local review, not persistent storage.

In another terminal:

```bash
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/accounts \
  -H 'Content-Type: application/json' -d '{"name":"John Doe"}'
```

Copy the returned account UUID for the examples below. For durable storage, configure Supabase or another dedicated PostgreSQL database as described next.

## Local Supabase database with persistent storage

Docker must be running. This project uses PostgreSQL port **54362**, Studio port **54363**, Supabase API port 54361 and shadow-database port 54360 to avoid collisions with other local Supabase projects. The Fastify API remains on port 3000.

```bash
nvm use
npm run supabase:start
npx supabase migration up --local
```

`supabase:start` starts PostgreSQL, Studio and the metadata/API services used by Studio. Open [Supabase Studio](http://127.0.0.1:54363/project/default/editor), then choose the **ledger** schema in the Table Editor to view `accounts`, `transactions` and `transfers`. The default **public** schema does not contain these application tables. This local Studio is separate from the hosted Supabase Dashboard.

If you previously started only PostgreSQL with `npx supabase db start`, the CLI may detect the running database and skip starting Studio. Stop this project's services with `npx supabase stop --project-id confluencr-ledger-api`, then run `npm run supabase:start`. The normal stop command retains database storage; the restart briefly interrupts database connections.

The Fastify API uses the `DATABASE_URL` in `.env` to connect. Before the first API start, configure a separate `ledger_runtime` login and apply [docs/runtime-grants.sql](docs/runtime-grants.sql); keep its real password only in the ignored `.env`. In this workspace the local setup includes that restricted role and `.env` configuration. Then start the API:

```bash
npm run dev
```

The database is independent of the API process, so stopping `npm run dev` preserves the database and its data. If `dev:local` is running on port 3000, stop that demo before starting `npm run dev`.

The local Supabase database uses Docker storage. Stop this project's services without deleting storage using `npx supabase stop --project-id confluencr-ledger-api`; do not use reset or no-backup options to stop it. `npx supabase db start` remains an option for database-only operation and does not start Studio.

## Hosted Supabase setup

1. Create/select a **development-only** Supabase project. Inspect existing schemas and migration history first. Never reset a shared/production database.
2. In the Supabase Dashboard **Connect** panel, copy the actual PostgreSQL URL. Use direct port **5432** when IPv6 works; otherwise use the **session pooler on port 5432** for IPv4. The backend is a persistent service; transaction pooling is unnecessary here. Do not use a Supabase API/service-role key as the database password.
3. Copy `.env.example` to `.env`; set `DATABASE_URL` to the PostgreSQL URL and optionally `DB_SSL_CA_FILE` to the downloaded Supabase CA PEM. Remote connections always use certificate/hostname verification. TLS/connection override query parameters are rejected; remove those parameters from copied URLs and use the dedicated CA setting. Do not set `rejectUnauthorized: false` or `NODE_TLS_REJECT_UNAUTHORIZED=0`.
4. Use the installed Supabase CLI and migration-owner credentials to inspect and apply the versioned SQL migrations. Examples below assume `MIGRATION_DATABASE_URL` is securely set in your shell, separate from runtime credentials; npm does not automatically export `.env` into your shell.

```bash
npx supabase --version
npx supabase migration list --db-url "$MIGRATION_DATABASE_URL"
npx supabase db push --db-url "$MIGRATION_DATABASE_URL" --dry-run
npx supabase db push --db-url "$MIGRATION_DATABASE_URL"
```

The migrations deliberately fail if an unrelated `ledger` schema already exists; investigate rather than overwriting it. Startup never runs migrations. Do not use `supabase db reset` against remote data. Supabase CLI dry-run/application is also exercised locally by `npm run migrations:verify`, which targets only a freshly created disposable database.

5. Create a non-owner runtime LOGIN role named `ledger_runtime` through your administration workflow with a strong secret. As migration owner, apply [docs/runtime-grants.sql](docs/runtime-grants.sql). Replace `.env`'s connection credentials with this runtime role. It has SELECT, account-name INSERT, balance UPDATE and posting/transfer INSERT; no DELETE, TRUNCATE, DDL, arbitrary initial balance or ledger UPDATE privileges. Adjust session-pooler usernames according to the actual Dashboard connection guidance for your role.
6. Keep `ledger` out of Supabase's exposed Data API schemas. PUBLIC schema/table/function access is revoked in the migrations. Review any additional project-specific role grants; migration owners and privileged administrators remain trusted. Browser applications must not receive the database URL.
7. Start the persistent API:

```bash
npm run dev             # watch mode; loads .env if present
# or:
npm run build
npm start               # compiled server; loads .env if present
```

The production build contains only `src` output. `SIGINT`/`SIGTERM` closes Fastify, lets active requests complete and ends the shared pool. Startup checks connectivity, required ledger migration tables/columns and read access before listening. Failed startup messages are sanitized.

## Environment

| Variable                   | Default       | Purpose                                                                    |
| -------------------------- | ------------- | -------------------------------------------------------------------------- |
| `DATABASE_URL`             | required      | Runtime PostgreSQL URL, never logged                                       |
| `NODE_ENV`                 | `development` | `development`, `test` or `production`                                      |
| `HOST`                     | `127.0.0.1`   | Bind address; use `0.0.0.0` explicitly for containers                      |
| `PORT`                     | `3000`        | HTTP port, 1–65535                                                         |
| `DB_SSL_CA_FILE`           | unset         | Optional provider CA PEM file; remote TLS always verified                  |
| `DB_POOL_MAX`              | `10`          | Maximum pool clients (1–100)                                               |
| `DB_CONNECTION_TIMEOUT_MS` | `10000`       | Acquisition/connection timeout                                             |
| `DB_IDLE_TIMEOUT_MS`       | `30000`       | Idle pooled connection timeout                                             |
| `DB_STATEMENT_TIMEOUT_MS`  | `30000`       | Statement and idle-in-transaction timeout                                  |
| `DB_LOCK_TIMEOUT_MS`       | `5000`        | Maximum lock wait                                                          |
| `TEST_DATABASE_URL`        | unset         | Optional external test-cluster admin URL; never defaults to `DATABASE_URL` |
| `LEDGER_EXTERNAL_TESTS`    | unset         | Must be `allow-create-disposable-database` to use an external test URL     |

Environment files are ignored by source control. `.env.example` contains placeholders only. Configuration is checked with Zod before startup, and invalid field names are reported without echoing values. Loopback databases default to plaintext; remote hosts always require verified TLS.

## API contract

See [openapi.yaml](openapi.yaml) for every request, response and error schema. The API uses JSON. Unknown body properties and NUL characters in names, descriptions or references are rejected. Monetary values are **strings** such as `"10"`, `"10.5"`, `"10.50"` or `"0.01"`; output uses two fractional digits. Maximum amount/balance is `9999999999999999.99`. Zero, negative, JSON numeric, exponent and overprecision amounts are rejected.

| Method | Path                         | Behavior                                                                                                              |
| ------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| POST   | `/accounts`                  | Create `{name}`; returns 201 with generated id/time and `"0.00"` balance                                              |
| GET    | `/accounts/:id/balance`      | Return `{account_id,balance}`                                                                                         |
| POST   | `/accounts/:id/transactions` | Atomically post `{type,amount,reference_id,description?}`; returns 201                                                |
| GET    | `/accounts/:id/transactions` | History; optional `type=credit\|debit`, `page=1`, `limit=20` (1–100)                                                  |
| POST   | `/transfers`                 | Atomic `{from_account_id,to_account_id,amount,reference_id}`; returns 201 with transfer metadata and two transactions |
| GET    | `/health`                    | Process availability, 200                                                                                             |
| GET    | `/ready`                     | Database/schema read readiness, 200 or 503                                                                            |

### Complete curl workflow

Start the API using one of the setup methods above. Run the following commands in the same second terminal; `-i` displays the HTTP status and response headers as well as the JSON body. The write requests create records in the database used by the API. Start with two new accounts when repeating the workflow, so existing references and balances do not affect the expected results.

```bash
BASE_URL=http://127.0.0.1:3000
```

**Check process health — `GET /health`.** Expected: 200 and `{"status":"ok"}`.

```bash
curl -i "$BASE_URL/health"
```

**Check database readiness — `GET /ready`.** Expected: 200 and `{"status":"ready"}` when the database and required ledger schema are accessible; otherwise 503 with `DATABASE_UNAVAILABLE`.

```bash
curl -i "$BASE_URL/ready"
```

**Create accounts — `POST /accounts`.** Each request returns 201 with `id`, `name`, `balance: "0.00"` and `created_at`. IDs and timestamps are generated by PostgreSQL; the request accepts only `name`.

```bash
curl -i -X POST "$BASE_URL/accounts" \
  -H 'Content-Type: application/json' -d '{"name":"Alice"}'
curl -i -X POST "$BASE_URL/accounts" \
  -H 'Content-Type: application/json' -d '{"name":"Bob"}'
```

Copy Alice's returned `id` into `SOURCE_ID` and Bob's into `DESTINATION_ID`; replace both placeholders before continuing.

```bash
SOURCE_ID="paste-alice-uuid-here"
DESTINATION_ID="paste-bob-uuid-here"
```

**Add credits — `POST /accounts/:id/transactions`.** These return 201 with the created transaction: `id`, `account_id`, `type`, `amount`, `description`, `reference_id`, `created_at` and `transfer_id` (null for standalone postings). Alice's balance becomes `"100.00"` and Bob's `"50.00"`. The same reference is allowed on different accounts.

```bash
curl -i -X POST "$BASE_URL/accounts/$SOURCE_ID/transactions" \
  -H 'Content-Type: application/json' \
  -d '{"type":"credit","amount":"100.00","description":"Initial deposit","reference_id":"deposit-001"}'
curl -i -X POST "$BASE_URL/accounts/$DESTINATION_ID/transactions" \
  -H 'Content-Type: application/json' \
  -d '{"type":"credit","amount":"50.00","description":"Initial deposit","reference_id":"deposit-001"}'
```

**Add a debit — `POST /accounts/:id/transactions`.** Expected: 201 with the debit transaction. Alice's balance becomes `"80.00"`. A debit exceeding the available balance returns 422 with `INSUFFICIENT_BALANCE` and makes no changes.

```bash
curl -i -X POST "$BASE_URL/accounts/$SOURCE_ID/transactions" \
  -H 'Content-Type: application/json' \
  -d '{"type":"debit","amount":"20.00","description":"Withdrawal","reference_id":"withdrawal-001"}'
```

**Read the balance — `GET /accounts/:id/balance`.** Expected: 200 with `account_id` equal to Alice's UUID and `balance: "80.00"` at this point in the workflow.

```bash
curl -i "$BASE_URL/accounts/$SOURCE_ID/balance"
```

**Read and filter history — `GET /accounts/:id/transactions`.** Each request returns 200 with `data` and `pagination`. The first request returns both transaction types, the second credits only, and the third debits only. Results are latest first. Before the transfer below, Alice has two total records: one credit and one debit. `page` defaults to 1; `limit` defaults to 20 and accepts 1–100.

```bash
curl -i "$BASE_URL/accounts/$SOURCE_ID/transactions?page=1&limit=20"
curl -i "$BASE_URL/accounts/$SOURCE_ID/transactions?type=credit&page=1&limit=20"
curl -i "$BASE_URL/accounts/$SOURCE_ID/transactions?type=debit&page=1&limit=20"
```

**Transfer money — `POST /transfers`.** Expected: 201 with transfer metadata (`id`, `from_account_id`, `to_account_id`, `amount`, `reference_id`, `created_at`) and a `transactions` array containing its linked debit and credit. Alice's balance becomes `"50.00"`; Bob's becomes `"80.00"`. Both accounts must exist and differ, and Alice must have sufficient funds. Repeating the same source/reference returns 409 with `DUPLICATE_TRANSFER`.

```bash
curl -i -X POST "$BASE_URL/transfers" \
  -H 'Content-Type: application/json' \
  -d "{\"from_account_id\":\"$SOURCE_ID\",\"to_account_id\":\"$DESTINATION_ID\",\"amount\":\"30.00\",\"reference_id\":\"transfer-001\"}"
curl -i "$BASE_URL/accounts/$SOURCE_ID/balance"
curl -i "$BASE_URL/accounts/$DESTINATION_ID/balance"
```

Repeating either credit request above returns 409 with `DUPLICATE_TRANSACTION` and the original transaction in `error.details`; it does not add another deposit. Validation, duplicate and insufficient-funds responses use the error contract below. Full JSON schemas and additional response examples are in [openapi.yaml](openapi.yaml).

Histories return `{data: [...], pagination: {page,limit,total_records,total_pages}}`. Totals respect the type filter. Empty histories have `total_pages: 0`. Ordering is `created_at DESC, id DESC`; page numbers must be positive decimal integers, maximum 2,147,483,647. Concurrent writes can appear between count and page queries under READ COMMITTED.

Errors consistently use:

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient balance for this debit",
    "details": []
  }
}
```

400 covers validation, malformed UUIDs and invalid pagination; 404 missing accounts; 409 duplicate posting/transfer; 422 insufficient balance; 500 sanitized unexpected/database failure. Oversized bodies return 413, unsupported content types 415; both retain the error envelope. Bodies are limited to 16 KiB. Failed operations do not alter committed ledger state. Numeric overflow returns 500 and rolls back the whole operation.

References preserve exact case/whitespace, must not be blank and are at most 200 characters. Same account + same reference returns **409**, with the original transaction in `error.details`, including when the new payload differs. The same reference on another account is allowed. There is no edit/delete API. The `transfer/` prefix is reserved for internal posting references.

Transfers use unique `(source account, reference)` metadata and generate two postings linked by `transfer_id`. The transfer's user reference belongs to metadata; ledger references are `transfer/<uuid>/debit` and `transfer/<uuid>/credit`. Repeated transfers return 409 with original metadata. They share the history endpoint with standalone postings, which have `transfer_id: null`.

The backend supplies a nonblank `description` for every new ledger entry. Standalone credits and debits preserve a nonblank description supplied by the caller; omitted, empty or whitespace-only values become `Credit transaction` or `Debit transaction`. Transfer entries automatically use `Transfer to Bob` and `Transfer from Alice` for accounts with those names. Transfer requests do not require a description field.

The third migration rejects future SQL inserts with null or blank descriptions. It preserves historical immutable entries, so older descriptions that were already null remain null. No existing ledger row is backfilled or made editable.

## Architecture and financial integrity

`src/app.ts` creates Fastify separately from `src/server.ts`. Routes handle HTTP and strict Zod parsing. Account, posting and transfer services contain business rules and parameterized SQL. `src/db/transaction.ts` owns dedicated clients and transaction boundaries; one pool is shared by the process. One error handler emits domain/validation responses and sanitizes unexpected errors. Logs retain request ID and SQLSTATE only for unexpected request failures; raw SQL errors, request bodies and connection strings are never logged.

The private `ledger` schema contains:

- `accounts`: UUID PK, nonblank bounded name, nonnegative finite NUMERIC(18,2) balance, system timestamp.
- `transactions`: UUID PK, restricted account FK, credit/debit check, positive finite amount, bounded description/reference, unique account/reference, timestamp, optional transfer FK. Index `(account_id, created_at DESC, id DESC)` supports history.
- `transfers`: UUID PK, two account FKs, distinct-account check, positive amount, unique source/reference, timestamp. A unique transfer/type constraint permits at most one debit and one credit per transfer. The service creates both together.
- Immutability triggers reject UPDATE/DELETE for ledger rows and transfer metadata. PUBLIC receives no schema/table/function access.

Posting lifecycle: validate before acquiring resources; BEGIN READ COMMITTED; lock the account row FOR UPDATE; check account/reference; compare debit funds in SQL; insert entry; adjust balance with exact PostgreSQL numeric arithmetic; COMMIT. Exceptions roll back, preserving the original failure and releasing the client in `finally`. Broken/uncertain connections are discarded. Unique-violation fallback checks the exact constraint name before classifying a duplicate; unrelated constraint failures remain sanitized server errors. CHECK failures are never blindly labeled insufficient funds.

Account locks prevent lost updates and overdrafts across multiple Node processes. Unrelated accounts remain independent. Transfers acquire each account lock sequentially in sorted canonical UUID order; both ledgers, both balances and transfer metadata commit together. Money conservation and balance/ledger reconciliation are asserted in tests. There are no JavaScript money calculations.

A connection failure during COMMIT can leave an **unknown outcome**. The server performs no automatic financial retries. Reuse the original reference to reconcile: a duplicate response confirms the original entry; generating a different reference could double-post.

## Verification

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run docs:validate
npm test
npm run migrations:verify
npm run runtime:verify
# All of the above, in order:
npm run verify
```

`npm test` includes unit tests and Fastify inject integration tests against a real PostgreSQL 17 process in a private temporary directory. The pool permits twelve concurrent clients. No Docker daemon, hosted credentials, arbitrary sleeps or database mocks are used for financial integration/concurrency tests. Mocks are limited to unit checks for client ownership/error paths and validation before database access.

Each test run creates a random `ledger_test_<uuid>` database; deletion requires matching the generated name, owner and a random database comment. The harness never migrates or cleans the admin URL's original database. Schema changes for failure injection are limited to this disposable database. Default runs never use `DATABASE_URL`.

To use another **dedicated test cluster**, explicitly set `TEST_DATABASE_URL` and `LEDGER_EXTERNAL_TESTS=allow-create-disposable-database`. The login needs CREATE DATABASE (and CREATEROLE for the privilege test). Do not point tests at shared development/production infrastructure. Set `DB_SSL_CA_FILE` if needed for remote certificate verification. The default local route needs no setup and is the verified path.

Coverage includes: the PDF balance sequence; decimal limits; overdrafts without writes; same-account and cross-account reference rules; ten parallel debits of 20 against 100 (exactly five succeed); ten duplicate credits (exactly one succeeds); reconciliation; filtered pagination and timestamp ties; FK/check/unique enforcement; SQL immutability; overflow and injected failures after ledger insertion; client release/rollback failures; transfer conservation, duplicate races, opposing transfers and full rollback; real HTTP requests, compiled-server shutdown, NUL rejection and readiness failure for incomplete migrations. OpenAPI validation checks documented operations against registered routes.

See [docs/ASSESSMENT_TEST_REPORT.md](docs/ASSESSMENT_TEST_REPORT.md) for coverage of each PDF requirement and the final 120-test results on both PostgreSQL and local Supabase. See [docs/DELIVERY_REPORT.md](docs/DELIVERY_REPORT.md) for command results, review findings and acceptance gates. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the PDF traceability matrix and [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) for explicit decisions.

## Limitations and submission

**Authentication and authorization are outside the scope of this assessment. The API is not suitable for handling real customer funds without additional access controls and operational protections.** Owners/admins are trusted and can bypass or alter database safeguards. Runtime credentials must remain private. No deployment, rate limiting, audit export, reconciliation repair service, global retry policy or cursor pagination is included. Large offset histories are sufficient for the assessment.

Hosted Supabase connection, project-specific grants, CA verification and hosted migrations remain unverified until configured in the designated project. Locally verified SQL and CLI migrations do not prove remote infrastructure works.

Submit the source, `package.json`/lockfile, SQL migrations, Supabase config, OpenAPI and documentation. Exclude `.env`, `node_modules`, build output and local database files. Preserve the original PDF for requirement context.

Provider guidance: [Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement), [PostgreSQL row locking](https://www.postgresql.org/docs/17/explicit-locking.html).
