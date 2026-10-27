# Implementation plan and requirements traceability

Source of truth: `Full Stack Developer Assessment.pdf` (five pages), read in full before implementation. The engineering prompt supplies the technology and stricter API contract. The workspace initially contained only the PDF; no source, usable Git metadata, environment configuration, or migrations existed.

## Requirements matrix

Final verification: all mandatory PDF requirements and the transfer bonus PASS locally. Hosted Supabase remains UNVERIFIED by user choice. Evidence is recorded in `docs/DELIVERY_REPORT.md`.

| ID  | Requirement / source                                                              | Class            | Implementation                             | Verification                                                           | Status                        |
| --- | --------------------------------------------------------------------------------- | ---------------- | ------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------- |
| A1  | Create account; generated UUID/time; required name; zero initial balance (PDF §1) | Mandatory        | accounts routes/service; initial SQL       | account integration tests                                              | PASS local                    |
| A2  | Credit/debit; positive amount; existing account (PDF §2,7)                        | Mandatory        | transaction schema/service                 | transaction tests                                                      | PASS local                    |
| A3  | Reject insufficient debit without changes (PDF §2,5)                              | Mandatory        | locked PostgreSQL transaction              | debit/concurrency/reconciliation tests                                 | PASS local                    |
| A4  | Unique reference within account; duplicates preserve state (PDF §2)               | Mandatory        | SQL unique constraint; duplicate lookup    | duplicate and concurrent duplicate tests                               | PASS local                    |
| A5  | Balance endpoint and missing-account errors (PDF §3)                              | Mandatory        | account routes/service                     | balance integration tests                                              | PASS local                    |
| A6  | History, optional type, pagination metadata, latest-first (PDF §4)                | Mandatory        | history SQL and query schema               | history integration tests                                              | PASS local                    |
| A7  | Immutable transactions; ledger/balance agreement (PDF §5)                         | Mandatory        | no mutation routes; immutable trigger      | HTTP and direct SQL integrity tests                                    | PASS local                    |
| A8  | Atomic ledger insert and balance update (PDF §5)                                  | Mandatory        | explicit BEGIN/COMMIT/ROLLBACK             | failure injection; overflow; reconciliation                            | PASS local                    |
| A9  | Validate inputs; consistent errors/statuses (PDF §7–8)                            | Mandatory        | strict Zod; global error handler           | schema/unit and HTTP integration tests                                 | PASS local                    |
| A10 | Maintainable structure, constraints, local run instructions (PDF §10)             | Mandatory        | TypeScript modules; SQL; README            | build/typecheck/lint; clean test DB                                    | PASS local                    |
| A11 | Source, README, API docs, assumptions (PDF §11)                                   | Mandatory        | README; OpenAPI; docs                      | OpenAPI validator; final cross-check                                   | PASS local                    |
| B1  | Atomic account transfer (PDF §9)                                                  | Bonus            | transfer routes/service; transfer SQL      | conservation, concurrency, full rollback                               | PASS local                    |
| E1  | Decimal strings; numeric(18,2); no JS money arithmetic                            | Prompt           | schemas; SQL arithmetic                    | precision, limits, overflow tests                                      | PASS local                    |
| E2  | Real concurrency: ten debits / same-reference credits                             | Prompt           | account row locking                        | real PostgreSQL with pool max >= 10                                    | PASS local                    |
| E3  | Supabase SQL migrations and safe access                                           | Prompt           | dedicated ledger schema; Supabase config   | isolated local application of identical SQL; hosted UNVERIFIED         | PASS local; hosted UNVERIFIED |
| E4  | Node 24, strict TS, Fastify, Zod, pg, npm lockfile                                | Prompt           | package/config                             | actual Node 24 commands                                                | PASS local                    |
| E5  | Validated env; pool timeouts; verified TLS; safe logging                          | Prompt           | config, pool, error handler                | configuration/unit and failure tests                                   | PASS local; hosted UNVERIFIED |
| E6  | Health/readiness, graceful shutdown                                               | Enhancement      | app/server                                 | inject and real HTTP smoke                                             | PASS local                    |
| E7  | Nonblank descriptions for all new ledger entries                                  | User requirement | posting/transfer services; third migration | defaults, blank inputs, named transfers, SQL checks and legacy upgrade | PASS local                    |

## Architecture

Fastify routes parse strict Zod schemas before touching the database. Services contain business rules and parameterized SQL. A shared pg pool serves requests; mutation operations own a dedicated client until commit or rollback. A small transaction helper guarantees release, preserves original failures, and discards clients when rollback/commit outcome is uncertain. One global handler maps domain/validation/database errors to a stable `{error:{code,message,details}}` envelope, without logging SQL, credentials, raw request bodies, or database error detail.

## Database

Use a dedicated `ledger` schema, outside Supabase's default browser-facing public schema. Accounts: UUID PK, nonblank bounded name, NUMERIC(18,2) nonnegative balance, timestamptz. Transactions: UUID PK, account FK ON DELETE RESTRICT, constrained credit/debit type, positive NUMERIC(18,2), optional description, nonblank reference, system time, UNIQUE(account_id, reference_id). History index `(account_id, created_at DESC, id DESC)`. A trigger rejects transaction UPDATE/DELETE. Revoke PUBLIC schema/table access; document explicit runtime role grants. Privileged administrators remain trusted. No auth implementation.

## API

POST /accounts -> 201 account. GET /accounts/:id/balance -> 200 balance. POST /accounts/:id/transactions -> 201 transaction. GET /accounts/:id/transactions -> 200 data and pagination. GET /health -> 200 process availability; GET /ready -> 200 or 503 database availability. Errors: 400 validation/UUID/pagination, 404 missing account, 409 duplicate including existing transaction, 422 insufficient funds, 500 sanitized database/internal failure. Body fields are strict; money is a positive decimal string, at most sixteen integer digits and two fraction digits. Default page 1, limit 20, maximum limit 100; safe bounded offset. Names trim; references preserve case and whitespace exactly, but cannot be all whitespace.

## Financial integrity

READ COMMITTED. BEGIN, lock account FOR UPDATE, verify existence, check reference, compare debit against balance in PostgreSQL, insert ledger row, update balance using numeric arithmetic, COMMIT. Every failure rolls back. Constraint uniqueness provides final duplicate enforcement. Overflow must roll back insertion. No blind retries after commit failure: outcome may be unknown; clients must reuse their reference to reconcile. Histories use ordinary READ COMMITTED queries; count/page can observe adjacent committed snapshots.

Transfers, if added after core verification: metadata table with UNIQUE(source, reference), two linked ledger rows, reserved reference namespace, sequential account locks sorted by normalized UUID, all changes in one transaction.

## Testing and execution

Use Vitest and Fastify inject plus a real disposable PostgreSQL server. Prefer local binaries; Docker is unavailable without additional permissions, so a dev-only packaged PostgreSQL distribution is acceptable. Integration harness creates a unique temporary database and validates ownership/identity before dropping only that database; never cleans arbitrary configured databases or shared schemas. Test all PDF requirements, monetary edge cases, ordering ties, failed debit state, constraints/triggers, forced failure after ledger insertion, numeric overflow, release on rollback failure, duplicate races, ten parallel debits, reconciliation. Unit tests cover config, Zod, error sanitation, and transaction client ownership. Validate OpenAPI and run typecheck, lint, format, build, tests, startup and real HTTP smoke under Node 24.

## Scope and environment decisions

Mandatory API and essential integration tests first; transfer bonus follows only after they pass. User explicitly selected local verification and hosted Supabase documented as unverified. No remote deployment or schema changes are authorized or necessary. Hosted connectivity and migrations remain UNVERIFIED without a designated project. Do not claim local PostgreSQL validates Supabase-specific network/TLS behavior. Final report must distinguish implemented, locally verified, and externally unverified requirements.
