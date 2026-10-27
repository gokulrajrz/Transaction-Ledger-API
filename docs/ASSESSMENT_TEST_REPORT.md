# Full Stack Developer Assessment — test report

Date: 28 October 2026 (Asia/Kolkata). Source: all five pages of `Full Stack Developer Assessment.pdf`, reread for this verification. Results apply to the current workspace after the test coverage changes described below.

**Result: every mandatory PDF requirement and the transfer bonus passed.**

## Environments and results

| Environment                                                | Test result                     | Additional checks                                                                                              |
| ---------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Node 24.22.1 + disposable PostgreSQL 17.10                 | 120 passed, 0 failed, 0 skipped | Baseline complete verification passed; final test suite rerun after all test changes                           |
| Node 24.22.1 + local Supabase PostgreSQL 17.11, port 54362 | 120 passed, 0 failed, 0 skipped | Final complete `npm run verify` passed, including CLI migrations and production/development server smoke tests |

There are **37 unit tests and 83 PostgreSQL integration tests** per suite run. These are 120 distinct tests executed on both database environments, not 240 distinct tests. Real HTTP scenarios are grouped into one integration test; the count is not inflated per assertion or request.

The final Supabase run passed type checking, ESLint, Prettier, production build, OpenAPI validation (seven documented operations), all tests, migration dry-run/application/version checks, and both compiled-server and `npm run dev` startup/shutdown checks. The default `npm test` also passed after the final test changes. The earlier 105-test baseline and 109-test PDF audit also passed before the backend description requirement was added.

## PDF requirement coverage

| PDF section    | Requirement                                                                                           | Evidence / test scenario                                                                                                                                                                    | Result |
| -------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1              | Create account with unique system ID, name, zero balance and system timestamp                         | Generated UUID/time assertions; distinct account IDs over HTTP; strict rejection of balance, ID, timestamp, blank/missing name and unknown fields                                           | PASS   |
| 2              | Transaction includes ID, account ID, type, amount, description, reference and timestamp               | Exact full response assertion, unique posting IDs, retained description, timestamp bounds and matching history record; rejects client-controlled system fields                              | PASS   |
| 2 Credit       | Credit increases balance                                                                              | Credits of 100 and 50, fractional and large exact values; real HTTP deposit                                                                                                                 | PASS   |
| 2 Debit        | Debit decreases balance; insufficient balance rejected without changes                                | Mandatory arithmetic sequence; balance/count checks after rejection; real HTTP withdrawal and overdraft                                                                                     | PASS   |
| 2 Duplicates   | Account-scoped reference uniqueness, no double posting, same reference on another account             | Original transaction in 409 details; same reference on another account succeeds; concurrent duplicate test                                                                                  | PASS   |
| 3              | Balance includes account_id and balance; missing account errors                                       | Exact balance response over HTTP; malformed UUID 400 and missing account 404                                                                                                                | PASS   |
| 4 Filtering    | Credit, debit and no-filter history                                                                   | Separate filtered totals and all-type history, both inject and network HTTP                                                                                                                 | PASS   |
| 4 Pagination   | Current page, page size, total count, total pages                                                     | Defaults, page boundaries, filtered totals, empty results, invalid parameters, real HTTP page size 1                                                                                        | PASS   |
| 4 Sorting      | Latest-first created_at order                                                                         | Newest posting first; equal-time fixtures assert deterministic secondary UUID order                                                                                                         | PASS   |
| 5 Immutability | No API edit/delete; protected fields remain unchanged                                                 | PUT/PATCH/DELETE rejected over HTTP; SQL attempts to change type, amount, description, reference, account ID and timestamp all rejected; DELETE rejected; original record preserved         | PASS   |
| 5 Consistency  | Stored balance represents valid ledger entries                                                        | PDF's 100 + 50 - 30 - 20 = 100 sequence; reconciliation after key scenarios and across every final test account                                                                             | PASS   |
| 5 Atomicity    | Entry insertion and balance update commit together; failure of either persists neither                | Forced entry-insert failure; forced balance-update failure after insert; overflow rollback; retry with original failed reference; released clients                                          | PASS   |
| 7 Validation   | Required name/reference, valid existing account/type/positive amount, duplicates and sufficient funds | Strict schemas, invalid/missing/unknown fields, invalid UUID, exact money boundary checks, NUL rejection and overdraft tests                                                                | PASS   |
| 8 Errors       | Appropriate HTTP codes and consistent meaningful error bodies                                         | Exact `{error:{code,message,details}}` envelope across missing account, invalid UUID/type/amount/reference/pagination/body, duplicate and insufficient balance; sanitized database failures | PASS   |
| 9 Bonus        | Both accounts exist, source funded, atomic debit/credit, complete rollback                            | PDF's 100/50 transfer of 30 produces 70/80 over real HTTP; missing accounts, insufficient funds, duplicate races, opposing transfers, overflow rollback and pair conservation               | PASS   |
| 10 Technical   | Backend/database, maintainable structure, constraints and local run instructions                      | Build/typecheck/lint, FK/CHECK/unique/immutability/index tests, real PostgreSQL and Supabase runs, development and compiled-server smoke tests                                              | PASS   |
| 11 Submission  | Source, README, API documentation and assumptions                                                     | Source and SQL migrations present; README and assumptions reviewed; OpenAPI parses and matches the seven registered operations                                                              | PASS   |

## Concurrency and financial invariants

- Ten simultaneous debits of 20 from 100: exactly **five 201** and **five 422** responses; five debit rows; final balance **0.00**.
- Ten simultaneous credits with the same account/reference: exactly **one 201** and **nine 409** responses; one posting and one balance increase.
- Ten transfers of 20 from 100: five complete transfers and five insufficient-funds rejections; no overdraft or partial pair.
- Ten concurrent opposing transfers complete without deadlock or loss of funds.
- Concurrent duplicate transfers commit exactly one debit/credit pair.
- Failed insert, update and overflow scenarios leave committed financial state unchanged. The original reference can be used after a fully rolled-back failure.
- A final SQL audit finds no account whose stored balance differs from its signed ledger total. Every transfer has exactly one matching debit and one matching credit, with zero net ledger change.

## Actual HTTP verification

The expanded integration test starts Fastify on a real loopback TCP port and uses `fetch`, in addition to the inject tests. It creates distinct accounts, posts credits/debits, rejects duplicates and overdrafts, runs the PDF transfer example, reads exact balances, verifies filtered pagination and newest-first order, rejects invalid requests, and verifies that mutation requests leave the original transaction unchanged.

Production and development process smoke checks additionally launch `dist/server.js` and actual `npm run dev` against disposable databases, verify health/readiness, create accounts/post credits, and assert graceful shutdown.

## Isolation and data preservation

The Supabase suite used the existing test harness with an admin connection passed only through process environment and explicit `LEDGER_EXTERNAL_TESTS=allow-create-disposable-database`. The admin password was read from the selected Docker container configuration without printing it or writing it into repository files. The normal API runtime login and `.env` were not changed.

Each fixture created its own random `ledger_test_<uuid>` database. Migrations, immutable-row tests, failure-injection triggers and cleanup ran only there. Cleanup checked the generated database name, owner and unique ownership marker before dropping it.

Before-and-after SQL fingerprints of the persistent application database's accounts, transactions, transfers and migration history matched. Lists of disposable database names and temporary test roles also matched, confirming no test databases or roles were left behind. Existing application data was not reset or cleaned.

## Finding and correction

The first targeted Supabase privilege-test run failed because its non-superuser admin had CREATEROLE but lacked permission to SET ROLE to the newly created test role. This is a **test-harness portability defect**, not a failed financial operation. The test now grants its administrator explicit SET permission on that temporary role inside the same transaction. The role, grant and test rows are all rolled back. All negative runtime privilege assertions remain in place. The final full runs passed with zero failures or skips.

The initial PDF audit expanded coverage without changing application behavior: complete transaction response fields, rejected system fields, both directions of write failure, all protected immutable columns, consistent error envelopes, all real HTTP assessment flows, and final global reconciliation.

## Backend-generated descriptions

The user subsequently required a description on every new ledger entry. The backend now preserves supplied nonblank posting descriptions, generates `Credit transaction` or `Debit transaction` when missing or blank, and generates `Transfer to <destination name>` / `Transfer from <source name>` for transfers. Account names are read under the existing account locks. Real HTTP assertions verify the generated descriptions as well as their persistence in transaction history.

Eleven additional cases cover absent/empty/whitespace descriptions for both posting types, explicit JSON null rejection, SQL null/blank rejection and upgrading a legacy database. The third migration adds an enforced CHECK for new rows using NOT VALID, preserving historical immutable NULL descriptions. The upgrade test proves the old row is unchanged and remains immutable while new API entries receive a generated description.

The expanded final 120-test suite passed on both PostgreSQL environments. Build, lint, typecheck, OpenAPI validation, three CLI migration versions, and production/development runtime checks passed. Applying the migration to the real local app database retained all existing account, transaction and transfer fingerprints; its two historical NULL descriptions were left unchanged.

## Reproduce

```bash
nvm use
npm run verify
```

The default command creates its own real PostgreSQL instance. To repeat on a designated test cluster with CREATE DATABASE and CREATEROLE privileges, securely set `SUPABASE_TEST_ADMIN_URL` to its real admin connection URL, then:

```bash
TEST_DATABASE_URL="$SUPABASE_TEST_ADMIN_URL" \
LEDGER_EXTERNAL_TESTS=allow-create-disposable-database \
npm run verify
```

The harness does not migrate or clean the database named in that admin URL; it creates and removes separately owned test databases. Keep credentials out of shell history, reports and Git.

## Limits

This verifies every stated PDF requirement and the described failure/concurrency cases; it is not exhaustive proof for every possible input, network fault or load profile. Hosted Supabase networking/TLS, external authentication and deployment remain outside this local assessment verification. A network failure around COMMIT is covered by client-lifecycle unit behavior and documented reference reuse, not by an injected physical network outage.
