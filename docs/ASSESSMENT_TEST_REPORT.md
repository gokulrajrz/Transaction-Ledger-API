# Assessment verification report

Reviewed and updated on 2026-10-28. All required account, posting, balance, history and atomic-transfer features are implemented. Verification targets real local PostgreSQL 17 and local Supabase; hosted networking, TLS and deployment require checks in the target project.

## Verification results

| Environment                                 | Tests      | Verification                                                      |
| ------------------------------------------- | ---------- | ----------------------------------------------------------------- |
| Node 22.9.0 + disposable PostgreSQL 17      | 147 passed | `npm run verify`                                                  |
| Node 22.22.3 + local Supabase PostgreSQL 17 | 147 passed | `npm run verify`; persistent data and migration history preserved |
| Node 24.22.1 + disposable PostgreSQL 17     | 147 passed | Test suite and runtime compatibility                              |

The suite contains 50 unit tests, 92 financial integration tests, four documentation tests and one physical-disconnect regression. Financial tests use real PostgreSQL. The disconnect test starts the actual server, interrupts its database TCP connection during a posting, verifies a 500 response with the server still running, then retries the same reference and confirms exactly one credit.

Verification includes type checking, ESLint, formatting, the production build, OpenAPI/example validation, all tests, Supabase CLI dry-run/application with recorded migration versions, and development/compiled-server HTTP and graceful-shutdown checks. Node.js 22.9 is the declared minimum and is tested directly, alongside Node 22.22.3 and Node 24.22.1. Compatible Swagger UI, documentation/test/lint dependencies and the `light-my-request` override keep the complete verification workflow runnable on that minimum.

A clean `npm ci --engine-strict` also passes under Node 22.9.0.

## Requirement coverage

| Requirement                 | Implementation and evidence                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account creation            | PostgreSQL-generated UUID/time, required trimmed name, zero initial balance, rejection of client-controlled system fields                        |
| Credits and debits          | Positive validated amounts; exact NUMERIC(18,2) arithmetic; insufficient funds rejected under account lock                                       |
| Numeric input compatibility | JSON numbers and decimal strings normalize to two-place strings; fractional cents and unsafe numeric integers rejected; responses remain strings |
| Duplicate protection        | Account-scoped posting references and source-scoped transfer references; concurrent duplicates commit once and return the original resource      |
| Balances                    | Required 100 + 50 - 30 - 20 sequence; final balance reconciled against signed ledger totals                                                      |
| History                     | Type filters, bounded pagination, latest-first ordering and deterministic UUID ties; count and page share one REPEATABLE READ snapshot           |
| Immutability                | No update/delete endpoints, database mutation triggers and restricted runtime grants                                                             |
| Atomicity                   | Posting/transfer failures, balance overflow and injected insert/update failures roll back all writes                                             |
| Transfers                   | Both accounts required; sufficient source funds; ordered account locks; linked debit/credit pair; conservation and rollback assertions           |
| Validation and errors       | Consistent HTTP envelope; UUID, body, pagination, amount and text validation; raw database errors and secrets excluded                           |
| Unicode identity            | Unpaired surrogates rejected in every text field; valid Unicode references preserved without UTF-8 collisions                                    |
| Readiness                   | Missing columns/required enforced constraints and disabled immutability triggers produce 503; process health remains available                   |
| Documentation               | Swagger UI, OpenAPI, API reference and generated Postman workflow validated over real HTTP                                                       |

## Schema and migrations

The submission has two migrations:

| Migration                                  | Purpose                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `20261028000100_initial_ledger_schema.sql` | Accounts, postings, validated nonblank descriptions, constraints, history index, immutability and private schema |
| `20261028000200_transfers.sql`             | Transfer metadata, linked postings, uniqueness and transfer immutability                                         |

The description requirement is part of the initial schema; no `NOT VALID` patch or historical backfill is needed for a fresh submission database. Startup never runs migrations or resets data. Existing installations keep their original migration history and must not replay the consolidated initial migration. Readiness accepts an older NOT VALID description constraint because it still enforces every new insert. Historical null/blank descriptions remain unchanged; a regression test verifies compatibility without modifying ledger history.

## Concurrency and failure results

- Ten concurrent debits of 20 from 100 commit five and reject five, leaving 0.00.
- Ten credits sharing one account/reference commit one posting and one balance increase.
- Competing transfers cannot overdraw; opposing transfers complete without deadlock or money loss.
- Both ledger entries, both balances and transfer metadata commit or roll back together.
- A deterministic concurrent-write test commits a new posting between history count and page reads; both reads still return the same earlier snapshot.
- A physical database disconnect fails only its request, discards the connection, and allows later requests to use replacement connections.
- COMMIT transport failure can still leave an unknown outcome. Clients reconcile using the original reference; the server never automatically retries financial writes.

## Documentation and isolation

The contract covers seven operations and validates 58 OpenAPI and eight API-reference examples. The generated Postman v2.1 collection executes 24 requests and 48 assertions against real HTTP, validates response schemas, and finishes with Alice at 50.00 and Bob at 80.00. Postman desktop and Newman are outside this verification.

Fixtures create randomly named databases. Cleanup checks the generated name, owner and random ownership marker before deletion. External cluster use requires explicit opt-in and database-creation privileges; tests never migrate or clean the admin URL's original database. Local Supabase verification compares persistent table fingerprints, migration history and temporary database/role lists before and after the run.

The company assessment PDF is removed from the source tree and ignored by Git. Existing Git history is unchanged.

## Scope and reproduction

```bash
nvm use
npm ci
npm run verify
```

Authentication/authorization, rate limiting, deployment, automatic reconciliation repair and cursor pagination remain outside the assessment scope. Privileged database owners remain trusted. Separate history page requests can see newer data. Local verification does not establish hosted connectivity or TLS.
