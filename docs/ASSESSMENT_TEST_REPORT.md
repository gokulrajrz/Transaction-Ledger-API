# Assessment verification report

Verified on **28 October 2026** using all five pages of [Full Stack Developer Assessment.pdf](../Full%20Stack%20Developer%20Assessment.pdf).

**Status: READY WITH DOCUMENTED LIMITATIONS.** All mandatory assessment features and the atomic transfer bonus are implemented and verified locally. Hosted Supabase connectivity, remote TLS and hosted migration application remain **UNVERIFIED**, as requested by the user. No deployment was performed.

## Requirements and implementation

| PDF section | Requirement                                                                  | Implementation / verification                                                                                                                  | Result       |
| ----------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1           | Unique system-generated account ID/time, required name, zero initial balance | Account routes/service and initial SQL; generated-field assertions, strict rejection of client-controlled fields                               | PASS locally |
| 2           | Complete transaction fields, credits and debits                              | Transaction routes/service; full response assertions, exact decimal boundaries and positive/negative balance changes                           | PASS locally |
| 2, 7        | Account-scoped references and duplicate handling                             | Row locks and SQL uniqueness; same-account rejection, cross-account reuse, original resource in 409 details                                    | PASS locally |
| 2, 5, 7     | Reject insufficient funds without changing state                             | Funds comparison under account lock; balance and row-count assertions after rejection                                                          | PASS locally |
| 3           | Current balance and missing-account errors                                   | Account balance route; exact response, malformed UUID 400 and missing account 404                                                              | PASS locally |
| 4           | Type filters, pagination metadata and latest-first history                   | History query/schema; filtered totals, defaults, boundaries, empty results and timestamp ties                                                  | PASS locally |
| 5           | Transaction immutability                                                     | No edit/delete API; triggers and runtime permissions; HTTP and SQL mutation attempts rejected for every protected field                        | PASS locally |
| 5           | Balance consistency and atomic writes                                        | Shared SQL transaction helper; PDF's 100 + 50 - 30 - 20 = 100 sequence, reconciliation, insert/update failures and overflow rollback           | PASS locally |
| 7–8         | Input validation and consistent meaningful errors                            | Strict Zod schemas and centralized error handler; invalid body/type/amount/reference/UUID/pagination and sanitized database failures           | PASS locally |
| 9           | Atomic money-transfer bonus                                                  | Transfer service and SQL; both accounts required, sufficient funds, linked entries, conservation, concurrent races and full rollback           | PASS locally |
| 10          | Maintainable backend/database, constraints and local startup                 | Node 24 / TypeScript / Fastify / PostgreSQL; build/lint, constraint tests, CLI migrations and development/production smoke checks              | PASS locally |
| 11          | Source, README, API documentation and assumptions                            | Source and migrations, [README](../README.md), [API reference](API_REFERENCE.md), [OpenAPI](../openapi.yaml) and [assumptions](ASSUMPTIONS.md) | PASS locally |

The engineering prompt additionally specifies decimal-string money, real concurrency tests, Supabase SQL migrations, validated configuration and verified remote TLS settings. The implementation includes these controls; actual hosted networking and TLS are outside the verified local scope. The later user requirement for backend-generated descriptions is also implemented and tested.

## Architecture and data controls

Routes handle HTTP and strict input parsing. Services execute parameterized SQL through one shared `pg` pool. `src/app.ts` creates Fastify separately from `src/server.ts`, allowing in-process and real HTTP tests. The error handler emits a consistent `{error:{code,message,details}}` envelope and omits raw SQL errors, request bodies and credentials from logs.

`src/db/transaction.ts` acquires a dedicated client and explicitly begins READ COMMITTED. A posting locks its account FOR UPDATE, verifies existence and reference uniqueness, checks debit funds in PostgreSQL, inserts the ledger entry and updates the stored balance before COMMIT. Transfers lock both accounts sequentially in normalized UUID order and commit metadata, both entries and both balances together. Unrelated accounts can proceed independently. All monetary arithmetic uses PostgreSQL NUMERIC(18,2); JSON money remains a decimal string.

Confirmed rollback scenarios leave no financial writes. A transport failure around COMMIT can have an unknown outcome; the service discards uncertain connections and performs no automatic financial retry. Clients must reconcile using the same reference and intended payload, as described in [failure recovery](API_REFERENCE.md#idempotency-and-failure-recovery).

The private `ledger` schema contains accounts, transactions and transfer metadata. Foreign keys, finite/nonnegative balances, positive amounts, bounded text, account-scoped/source-scoped references and transfer-pair uniqueness complement service validation. Immutability triggers reject UPDATE/DELETE on postings and transfer metadata. The restricted runtime role is tested using [runtime grants](runtime-grants.sql); ledger mutation, arbitrary initial balances, TRUNCATE and DDL are denied. Privileged database owners remain trusted.

All new postings require nonblank descriptions. The backend preserves supplied nonblank text, defaults missing/blank descriptions to `Credit transaction` / `Debit transaction`, and generates named transfer descriptions while the accounts are locked. Historical entries remain immutable, including pre-existing NULL descriptions.

## Database and migrations

Local verification covers disposable PostgreSQL **17.10** and local Supabase PostgreSQL **17.11**. Persistent local Supabase uses database port **54362** and Studio port **54363**. Setup and connection instructions are maintained in the [README](../README.md#local-supabase-database-with-persistent-storage).

All **three migrations** are verified through the official Supabase CLI's dry-run, application and version-history checks:

| Migration                                             | Purpose                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `20261028000100_initial_ledger_schema.sql`            | Accounts, postings, constraints, history index, immutability and private schema |
| `20261028000200_transfers.sql`                        | Transfer metadata, linked postings, uniqueness and transfer immutability        |
| `20261028000300_require_transaction_descriptions.sql` | Require nonblank descriptions for new rows without rewriting historical entries |

Startup and `/ready` check required tables/columns and read access. They do not automatically run migrations or prove complete write privileges. Remote connections enforce certificate/hostname verification in configuration; successful local checks do not establish hosted TLS or connectivity.

## Verification results

| Environment                                    | Tests                               | Other checks                                                      |
| ---------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| Node 24.22.1 + disposable PostgreSQL 17.10     | **124 passed, 0 failed, 0 skipped** | Complete `npm run verify`                                         |
| Node 24.22.1 + local Supabase PostgreSQL 17.11 | **124 passed, 0 failed, 0 skipped** | Complete `npm run verify`; persistent data fingerprints unchanged |

Each suite contains **37 unit tests, 83 financial integration tests and four documentation tests**. These are 124 distinct tests run on two database environments. Requests and assertions inside a test are not counted as separate tests. Financial integration tests use real PostgreSQL; mocks are limited to lifecycle/error paths, validation before access and documentation independence from the database.

| Command                     | Result                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`         | PASS                                                                                                   |
| `npm run lint`              | PASS                                                                                                   |
| `npm run format:check`      | PASS                                                                                                   |
| `npm run build`             | PASS                                                                                                   |
| `npm run docs:validate`     | PASS; seven routes, 59 contract/eight reference examples, Postman schema and generated-artifact checks |
| `npm test`                  | PASS; 124 tests                                                                                        |
| `npm run migrations:verify` | PASS; dry-run, application and all three recorded versions                                             |
| `npm run runtime:verify`    | PASS; compiled/development server, real HTTP writes and graceful shutdown                              |
| `npm run verify`            | PASS; all checks above in sequence                                                                     |

### Financial invariants and concurrency

- Ten simultaneous debits of 20 from 100 produce exactly **five 201** and **five 422** responses; final balance **0.00**.
- Ten concurrent credits with one account/reference produce **one 201** and **nine 409** responses; one posting and one balance increase.
- Ten competing transfers of 20 from 100 commit five complete transfers and reject five; no overdraft or partial pair.
- Ten opposing transfers complete without deadlock or loss of funds. Concurrent duplicate transfers commit exactly one pair.
- Insert failure, balance-update failure and destination overflow roll back preceding writes. The original reference succeeds after a confirmed rollback.
- Large amounts preserve exact cents beyond JavaScript's safe integer range. SQL constraints reject NaN and invalid balances, types, references and foreign keys.
- Final SQL reconciliation finds no account balance differing from its signed ledger total. Every transfer has exactly one matching debit and credit with zero net ledger change.
- Description tests cover absent/empty/whitespace values, explicit null rejection, SQL enforcement and migration of an immutable legacy row without rewriting it.

### HTTP and documentation

Integration tests start Fastify on a real TCP port and use `fetch` for every assessment endpoint, including errors, filters, pagination, the PDF transfer example and rejected mutations. Process checks additionally launch `dist/server.js` and actual `npm run dev`, verify health/readiness, create accounts/post credits, and assert graceful shutdown.

Swagger UI at `/docs/` serves local JavaScript/CSS and matching `/docs/json` / `/docs/yaml` contracts without database queries. Repository files are not exposed through that prefix. OpenAPI examples are checked against response schemas; valid request examples are additionally checked against the application's Zod schemas. The API reference's eight JSON examples and local links are validated.

The generated Postman collection conforms to the official vendored v2.1 schema. Deterministic generation checks reject stale exports. A local contract harness executes all **24 collection requests and 48 named assertions** over real HTTP against isolated PostgreSQL and validates every response against its documented status/schema. Final balances reconcile at Alice **50.00**, Bob **80.00**, after duplicate, invalid-input and overdraft rejections. This verifies the exported workflow through a harness; Postman desktop and Newman execution were not performed.

Read-only HTTP checks also confirmed that the configured API on port 3000 serves the UI, contract, bundle, stylesheet and initializer. Documentation verification sent no financial mutations to the persistent application database.

## Review findings and corrections

The implementing agent performed a separate review pass; this is not a claim of external human review. Confirmed findings were corrected and checked:

| Area                           | Correction / evidence                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Configuration                  | Guard malformed database URL parsing so validation produces standardized errors without exposing secrets                         |
| Transaction isolation          | Explicit READ COMMITTED prevents overridden database defaults from changing the locking protocol; lifecycle and race tests pass  |
| Numeric constraints            | Explicit NaN exclusion prevents PostgreSQL NUMERIC special values from passing positivity checks; direct SQL tests pass          |
| Error classification           | Match SQLSTATE and exact constraint name before mapping a unique failure to a financial duplicate; unrelated failures remain 500 |
| Text validation                | Reject NUL in names, descriptions and references before PostgreSQL access; regression cases return 400                           |
| Schema readiness               | Check required posting/transfer structure and read access; missing columns produce 503 instead of false readiness                |
| Disposable demo shutdown       | Isolate the PostgreSQL worker so terminal Ctrl+C allows ownership checks and temporary database cleanup                          |
| Supabase test-role portability | Grant the temporary administrator SET permission inside the test transaction; all role/grant/test rows roll back                 |
| API contract                   | Reject zero in the documented amount pattern and verify it against application validation boundaries                             |

Suspected double-posting, stale-balance races and opposing-transfer deadlocks were rejected based on account locks, SQL uniqueness and real concurrency results. Repeatable-read history, external authentication and administrator-proof storage are not claimed requirements: snapshot limitations, excluded authentication and the privileged-owner boundary are documented in [assumptions](ASSUMPTIONS.md).

## Isolation and reproduction

Every fixture creates a random `ledger_test_<uuid>` database; cleanup validates its generated name, owner and unique ownership marker before dropping it. Migrations, failure-injection triggers and SQL mutation attempts run only there. Default tests never use the application's `DATABASE_URL`.

The Supabase verification supplies admin credentials only through process environment, with explicit external-test opt-in. Credentials are neither printed nor committed. Before/after SQL fingerprints match for existing accounts, postings, transfers and migration history. Lists of temporary test databases and roles also match; no test artifacts are left behind. The runtime `.env` and existing application records are preserved.

```bash
nvm use
npm ci
npm run verify
```

The default verification starts its own PostgreSQL instance. To use a designated test cluster with CREATE DATABASE and CREATEROLE privileges, securely set `SUPABASE_TEST_ADMIN_URL`, then run:

```bash
TEST_DATABASE_URL="$SUPABASE_TEST_ADMIN_URL" \
LEDGER_EXTERNAL_TESTS=allow-create-disposable-database \
npm run verify
```

The database named by that admin URL is not migrated or cleaned; fixtures create and remove separate test databases. Keep credentials out of shell history and Git. Startup/submission instructions are in the [README](../README.md#limitations-and-submission).

## Verification limits

The results cover the stated assessment requirements and tested concurrency/failure cases, not every possible input, network fault or load profile. COMMIT uncertainty is covered through client-lifecycle unit behavior and recovery documentation, not an injected physical network outage. Readiness is a read check, not full write-privilege verification.

Hosted Supabase networking/TLS, hosted migrations, project-specific access controls and deployment remain unverified. Authentication/authorization, rate limiting, automatic reconciliation repair and cursor pagination are excluded. Privileged owners can change database safeguards. This assessment API is not presented as suitable for real customer funds without additional controls.
