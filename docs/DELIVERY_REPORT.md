# Final engineering report

Verified on 28 October 2026 (Asia/Kolkata). Host runtime was Node 22; all application verification used a temporary Node **24.22.1** installation. PostgreSQL executable reports **17.10**. The source assessment PDF was read in full before implementation.

## 1. Final status

**READY WITH DOCUMENTED LIMITATIONS**

All mandatory assessment features and the transfer bonus are implemented and verified locally against real PostgreSQL. Hosted Supabase connectivity, remote TLS, hosted migrations and project-specific grants remain **UNVERIFIED**, as explicitly requested by the user. No deployment or remote database changes were performed.

## 2. Requirements completion and acceptance gates

| Requirement                                              | Result       | Evidence                                                                                                      |
| -------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| Account creation, generated fields, zero initial balance | PASS locally | Account integration tests; real HTTP smoke                                                                    |
| Balance retrieval and missing/invalid account errors     | PASS locally | All account routes tested                                                                                     |
| Credit/debit, insufficient funds, exact money            | PASS locally | Mandatory 100 + 50 - 30 - 20 sequence; large/fractional values; overdraft assertions                          |
| Account-scoped references and duplicate details          | PASS locally | Same/cross-account tests; ten concurrent identical credits                                                    |
| History filtering, pagination and ordering               | PASS locally | Type-specific totals; empty pages; equal-time UUID sorting                                                    |
| Immutability, constraints and atomicity                  | PASS locally | Direct SQL checks; forced update failure; numeric overflow                                                    |
| Validation and consistent errors                         | PASS locally | Unit/integration tests; sanitized malformed bodies/database failures                                          |
| Bonus transfers                                          | PASS locally | Pair linkage; conservation; duplicate race; opposing transfers; overdraft race; destination overflow rollback |
| Documentation and reproducible setup                     | PASS locally | README; assumptions; traceability; clean npm ci; OpenAPI validation                                           |
| Supabase CLI SQL migration workflow                      | PASS locally | Both migrations dry-run and applied through official CLI; both version records checked                        |
| Hosted Supabase                                          | UNVERIFIED   | No designated project/credentials; user chose local-only verification                                         |

| Gate                                               | Result                                                |
| -------------------------------------------------- | ----------------------------------------------------- |
| A — Mandatory PDF requirements                     | PASS locally                                          |
| B — Database schema/constraints/indexes/migrations | PASS locally; hosted application UNVERIFIED           |
| C — Atomic credit/debit                            | PASS                                                  |
| D — Concurrent debit protection                    | PASS                                                  |
| E — Duplicate prevention                           | PASS                                                  |
| F — Exact monetary values                          | PASS                                                  |
| G — API validation/error behavior                  | PASS                                                  |
| H — Real PostgreSQL tests                          | PASS                                                  |
| I — Documentation/API contract                     | PASS                                                  |
| J — Security within assessment scope               | PASS local review; remote project boundary UNVERIFIED |

The detailed requirement-to-code/test matrix is in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## 3. Architecture

Fastify routes parse strict Zod schemas before database access. Small services implement account, posting and transfer behavior with parameterized `pg` queries. One process-wide pool owns connections; mutation transactions retain a dedicated client until completion. Money arithmetic stays in PostgreSQL NUMERIC(18,2), with string inputs/outputs. Application construction is separate from startup. A centralized error handler sanitizes failures. Health/readiness, bounded timeouts and graceful shutdown are included.

## 4. Supabase integration

Subsequent local setup requested by the user: a dedicated Supabase PostgreSQL **17.11** Docker service, `supabase_db_confluencr-ledger-api`, is running on **127.0.0.1:54362**. The default 54322 port belonged to another project, so this project's configuration uses 54362 (database), 54360 (shadow database) and 54361 (Supabase API configuration). Both migrations were applied by `supabase db start`; `supabase migration up --local` then confirmed no migrations were pending.

The ignored `.env` now uses a dedicated `ledger_runtime` login with a generated password. The role has no superuser, database-creation, role-creation or RLS-bypass privileges. Supabase `anon`, `authenticated` and `service_role` roles were checked and have no USAGE on `ledger`. Live verification through the runtime login covered credits, debits, linked transfers, money conservation, ledger reconciliation, and an API HTTP `/ready` response of 200. All verification writes were rolled back. This is a persistent local Supabase database independent of API process lifetime; it does not verify hosted Supabase networking or TLS.

- The schema is private `ledger`, outside default public Data API exposure. Source-controlled SQL migrations create accounts, transactions, transfers, FKs, checks, uniqueness, history/destination indexes and immutability triggers.
- Official project dependency: Supabase CLI 2.122.0. `db push --dry-run` and `db push` both succeeded against a freshly created local disposable database. Both migration versions were checked in `supabase_migrations.schema_migrations`.
- Runtime-role SQL grants are provided and verified: permitted operations work; system-field inserts, ledger mutation, TRUNCATE and DDL are denied. Database owner/admin access remains trusted.
- Hosted guidance selects direct 5432 when IPv6 is available, otherwise session pooler 5432. No remote connection method was actually used. Remote application pools enforce TLS certificate/hostname validation; actual remote CA verification remains untested. Only disposable loopback CLI verification uses `sslmode=disable`.

## 5. Tests and commands executed

Final automated suite: **105 passed, 0 failed, 0 skipped**, across two files: **37 unit tests** and **68 real PostgreSQL integration tests**. The last complete run finished successfully after the clean lockfile installation and all code fixes.

| Command                                        | Final result                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm ci --offline` (using populated npm cache) | PASS; 224 packages installed; audit reported 0 vulnerabilities                                      |
| `npm run typecheck`                            | PASS                                                                                                |
| `npm run lint`                                 | PASS (ESLint 10)                                                                                    |
| `npm run format:check`                         | PASS                                                                                                |
| `npm run build`                                | PASS                                                                                                |
| `npm run docs:validate`                        | PASS; seven operations match registered routes; monetary patterns agree on boundary/invalid samples |
| `npm test`                                     | PASS; 105/105                                                                                       |
| `npm run migrations:verify`                    | PASS; Supabase CLI dry run, application, recorded versions                                          |
| `npm run runtime:verify`                       | PASS; compiled production server and actual `npm run dev`, real HTTP accounts/postings and shutdown |
| `npm run dev:local`                            | PASS manual terminal check; starts on port 3000; Ctrl+C confirms temporary database removal         |
| `npm run verify`                               | PASS; all checks above in sequence (installation performed separately)                              |

Build/test commands used Node 24 via a temporary PATH because the host default is Node 22. Tests and TypeScript runners required execution outside the restricted sandbox to bind local TCP/IPC sockets; these are environment permissions, not disabled application checks. A clean install also needed that execution context for esbuild's binary validation. The initial dependency resolver error was resolved using npm 11; subsequent clean `npm ci` with the lockfile passed. ESLint was updated from the deprecated major 9 to maintained major 10.

Integration tests create a fresh, randomly named database with a unique ownership marker; cleanup validates name, owner and marker before deleting only that database. Default tests launch actual PostgreSQL in a private temporary directory. No financial concurrency or ACID assertion relies on mocks. Unit mocks cover validation-before-access, client ownership, rollback failure, ambiguous commit and sanitized failure responses.

## 6. Data integrity evidence

- Ten concurrent debits of 20 against balance 100: **five 201 responses, five 422 responses**, five debit rows and final balance **0.00**.
- Ten concurrent credits with one account/reference: **one 201 response, nine 409 responses**, one credit row and one balance increase.
- Rejected debits leave both balance and transaction count unchanged. Reconciliation compares SQL ledger totals with stored balance after major posting/transfer scenarios.
- Money beyond JavaScript's safe integer precision retains exact cents. Overflow after ledger insertion rolls back the new row and balance mutation.
- Controlled balance-update failure after insertion rolls back the ledger entry; the original reference succeeds after the injected failure is removed. Pool clients return to idle state.
- Direct SQL rejects invalid balances, types, amounts (including NaN), references, missing-account FKs and duplicate references. UPDATE/DELETE triggers protect immutable rows; runtime privileges additionally deny mutation and TRUNCATE.
- Opposing concurrent transfers complete without deadlock. Ten competing source transfers allow exactly five successes. Destination overflow rolls back the source debit, both postings and metadata. Successful transfers conserve combined balances and link exactly two ledger rows.
- BEGIN explicitly sets READ COMMITTED. Each relevant account is locked FOR UPDATE, with two-account locks acquired sequentially in canonical UUID order. No in-memory mutex or automatic financial retries exist.

## 7. Code review and fixes

The same autonomous agent performed a separate review pass after implementation; no claim of an external human review is made. No unresolved critical/high-impact defect was found within the assessment boundary.

| Location / exact operation                                                            | Trigger and consequence                                                                                                    | Classification                                                   | Fix / verification                                                                  |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/config/env.ts`: `databaseUrl.superRefine`                                        | Malformed URL made `new URL()` throw before standardized field errors                                                      | Confirmed defect, Low                                            | Guard parsing; malformed secret-bearing URL regression passes                       |
| `src/db/transaction.ts`: `inTransaction`, BEGIN                                       | An overridden database isolation default contradicted READ COMMITTED and could introduce unexpected serialization failures | Confirmed configuration risk, Medium                             | Explicit isolation in BEGIN; transaction lifecycle tests and real races pass        |
| `supabase/migrations/20261028000100_initial_ledger_schema.sql`: balance/amount CHECKs | NUMERIC NaN compares above ordinary values; positivity alone is insufficient                                               | Confirmed database behavior, Medium; mitigated in initial schema | Explicit NaN exclusion; direct SQL checks reject NaN                                |
| `openapi.yaml`: `components.schemas.Amount.pattern`                                   | Zero matched the original documentation pattern although the API rejected it                                               | Confirmed documentation defect, Low                              | Positive-only pattern; executable comparison with Zod boundaries                    |
| `src/db/types.ts`: `isConstraintViolation`; posting/transfer catch blocks             | Unrelated unique failures must not be mislabeled as financial duplicates                                                   | Design risk, Medium; no broad mapping exists in final code       | Exact SQLSTATE/constraint match; unrelated constraint error unit test remains 500   |
| `scripts/verify-supabase.ts`: CLI `db push`                                           | CLI required TLS on a disposable server without TLS and verification failed                                                | Environment limitation, resolved                                 | Plaintext limited to generated loopback target; subsequent dry-run/application pass |

`scripts/local.ts` (confirmed defect, Medium): terminal Ctrl+C and the packaged PostgreSQL helper's signal hook stopped PostgreSQL before `fixture.stop()` could validate and remove the test database. Reproduced through a real PTY. The launcher now isolates the database worker and sends an IPC stop message; repeated Ctrl+C printed “temporary database removed” without a database error. The worker imports the helper separately so its exit hook cannot run in the launcher. This worker is confined to disposable demonstration tooling; the API uses no background business workers.

Follow-up audit after the user asked whether anything was missed confirmed two additional gaps:

- **Low — text validation**: `src/common/validation.ts`, account-name and posting-description schemas accepted NUL characters, which PostgreSQL TEXT rejects. Four regression cases (name, posting reference, description, transfer reference) reproduced 500 instead of the intended 400. Shared text validation now rejects NUL before database access; the account boundary unit test also checks that no database resource is acquired. OpenAPI and assumptions record the restriction.
- **Medium — incomplete migration readiness**: `src/app.ts` and `src/server.ts` checked only `ledger.accounts`, so an installation missing the transfer migration could report ready while posting failed. A regression temporarily renames `transactions.transfer_id` in the disposable database and reproduced an incorrect 200. Startup and `/ready` now share `src/db/readiness.ts:checkDatabase`, checking both migrations' required tables/column and SELECT access without scanning data. Missing migration structure returns 503; health remains available.

These five regressions failed before the fixes. The final full suite includes them; targeted-run filtering was used only to reproduce the findings, not to omit tests from final acceptance.

All changes were revalidated after fixes. A TypeScript test-helper annotation and a lint-only issue in the smoke script were also corrected before the final passing run.

## 8. False-positive audit

| Suspected issue                                                  | Disposition and evidence                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate precheck alone allows double posting                   | Rejected: account row lock serializes API writers and named SQL uniqueness is final enforcement; ten concurrent requests commit exactly one posting       |
| Concurrent debits can read a stale balance                       | Rejected: FOR UPDATE waits and reads the locked account version; the ten-request test deterministically commits five debits                               |
| Transfers can deadlock on opposite directions                    | Rejected for API operations: UUIDs normalize case and locks are acquired one at a time in the same sorted order; opposing-transfer test passes            |
| JavaScript Number loses monetary precision                       | Rejected: Number is used for pagination/count metadata only; amounts/balances remain strings and arithmetic occurs in SQL; large exact-cent test passes   |
| History requires repeatable-read isolation                       | Optional improvement: PDF does not demand snapshot pagination; adjacent READ COMMITTED snapshots are explicitly documented                                |
| Owners can bypass immutability or change balances directly       | Documented trust boundary, not a claim of administrator-proof storage; restricted role denies mutation/DDL and owner protections are explicitly qualified |
| Authentication is missing                                        | Intentionally excluded assessment scope, documented prominently; not presented as suitable for real customer funds                                        |
| Hosted Supabase must have been verified because local SQL passed | Rejected inference: all hosted gates remain explicitly UNVERIFIED                                                                                         |

## 9. Known limitations

Hosted database networking/TLS/grants/migrations are unverified. Authentication/authorization are excluded. Privileged owners can alter protections. History uses offset pagination and separate count/page snapshots. Commit network failures can have unknown outcomes; references must be reused to reconcile. No deployment was performed. Default PostgreSQL demo/test launch requires a non-root user and supported native platform. The development watcher smoke is verified on Linux/POSIX; Windows runtime verification covers the compiled server only.

No credentials were committed. Generated local Supabase credentials are stored only in the ignored `.env`; the example contains placeholders. A static scan found no private keys or recognizable secret-token patterns in deliverable files; this is a scoped review, not a guarantee against every secret format. The original `.git` location was exposed as an empty, read-only environment mount. Initial Git publication used an isolated clone of `https://github.com/gokulrajrz/Transaction-Ledger-API.git`; the remote was empty when inspected, so there was no prior history to audit or overwrite. The current workspace was subsequently connected directly to `origin/main` using elevated Git access.

## 10. Submission instructions

Use Node 24, then `npm ci`, `npm run verify` and `npm run dev:local` for disposable local review. For durable Supabase storage, follow the README: inspect the designated development project, configure verified TLS and separate migration/runtime credentials, review/apply SQL migrations, grant runtime access, then `npm run dev` or `npm run build && npm start`.

Submit source, package manifest/lockfile, Supabase config/migrations, OpenAPI, README and `docs`. Exclude environment secrets, dependencies, build output and database files. The original assessment PDF is preserved. No remote database or deployment action is implied by submission readiness.
