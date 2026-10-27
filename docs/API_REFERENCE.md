# Confluencr Transaction Ledger API

**API contract 1.0.0 · OpenAPI 3.0.3 · Node.js 22.9+ / Fastify / PostgreSQL**

This reference describes the implemented API for accounts, immutable credit/debit entries and atomic account transfers. The machine-readable contract is [openapi.yaml](../openapi.yaml). Configuration and database setup are in the [README](../README.md).

| Resource                  | Location                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| Interactive Swagger UI    | [http://127.0.0.1:3000/docs/](http://127.0.0.1:3000/docs/)                       |
| OpenAPI JSON              | `GET /docs/json`                                                                 |
| OpenAPI YAML              | `GET /docs/yaml`                                                                 |
| Postman collection        | [Confluencr.postman_collection.json](postman/Confluencr.postman_collection.json) |
| Postman local environment | [Local.postman_environment.json](postman/Local.postman_environment.json)         |
| Verification evidence     | [Assessment test report](ASSESSMENT_TEST_REPORT.md)                              |

## Contents

1. [Connection and protocol](#connection-and-protocol)
2. [Quick start and client workflow](#quick-start-and-client-workflow)
3. [Data conventions](#data-conventions)
4. [Endpoint directory](#endpoint-directory)
5. [Create an account](#create-an-account)
6. [Read an account balance](#read-an-account-balance)
7. [Post a credit or debit](#post-a-credit-or-debit)
8. [Read transaction history](#read-transaction-history)
9. [Transfer money](#transfer-money)
10. [Health and readiness](#health-and-readiness)
11. [Error reference](#error-reference)
12. [Idempotency and failure recovery](#idempotency-and-failure-recovery)
13. [Consistency and immutability](#consistency-and-immutability)
14. [Client examples](#client-examples)
15. [Operational behavior and compatibility](#operational-behavior-and-compatibility)

## Connection and protocol

| Property           | Contract                                                  |
| ------------------ | --------------------------------------------------------- |
| Local base URL     | `http://127.0.0.1:3000`                                   |
| Resource paths     | Unversioned; no `/api` or `/v1` prefix                    |
| Request body       | JSON object, `Content-Type: application/json`             |
| Response body      | JSON for business/operational endpoints                   |
| Money              | String or numeric inputs; decimal-string outputs          |
| Identifiers        | UUID strings; accepted UUID inputs normalize to lowercase |
| Time               | System-generated ISO 8601 timestamps serialized in UTC    |
| Request body limit | 16 KiB; oversized bodies return 413                       |
| Authentication     | No authentication or authorization is implemented         |

Authentication and authorization are outside this assessment's scope. The API is not suitable for real customer funds without additional access controls and operational protections. Swagger UI uses the current API origin; do not treat its availability as an authentication boundary.

`Accept: application/json` is a useful client convention. Set `Content-Type: application/json` for every POST. Unsupported media types such as `application/xml` return 415; a body parsed as plain text may instead fail object validation with 400. Application errors never expose raw SQL, connection strings or stack traces.

## Quick start and client workflow

Start the configured API from the repository:

```bash
nvm use
npm run dev
```

Alternatively, `npm run dev:local` creates a disposable PostgreSQL demonstration database. See the README before choosing persistent Supabase storage or disposable storage.

Open [Swagger UI](http://127.0.0.1:3000/docs/). Select an operation, choose **Try it out**, supply valid input and choose **Execute**. POST requests create actual records in whichever database the API uses.

For Postman, import both linked JSON files, select **Confluencr Local**, confirm `base_url`, and run the collection in its listed order. The collection creates fresh Alice/Bob accounts, captures their IDs, and generates a fresh run identifier for references. It then funds, debits and transfers between those accounts and verifies successful and rejected requests. Re-running it creates another pair of demonstration accounts; it does not delete ledger history.

The complete collection workflow is:

| Step | Operation                          | Alice balance | Bob balance |
| ---- | ---------------------------------- | ------------: | ----------: |
| 1    | Create both accounts               |        `0.00` |      `0.00` |
| 2    | Credit Alice 100 and Bob 50        |      `100.00` |     `50.00` |
| 3    | Debit Alice 20                     |       `80.00` |     `50.00` |
| 4    | Transfer 30 from Alice to Bob      |       `50.00` |     `80.00` |
| 5    | Duplicate/invalid/overdraft checks |       `50.00` |     `80.00` |

Examples below use illustrative UUIDs. Always replace them with IDs returned by your own account-creation requests. Shell variables must be set in each terminal; the Postman collection handles ID capture automatically.

## Data conventions

### Exact money

`amount` accepts a positive decimal **string or finite JSON number** with up to two fractional digits, and normalizes to a two-place decimal string. Strings support up to `9999999999999999.99`. Numeric inputs cannot exceed `9007199254740991` (`Number.MAX_SAFE_INTEGER`); use strings for large exact values because JSON numbers are parsed as JavaScript floating point. Fractional cents are rejected without rounding.

| Accepted                                  | Rejected                                                  |
| ----------------------------------------- | --------------------------------------------------------- |
| `50`, `10.5`, `"10"`, `"10.50"`, `"0.01"` | `0`, `-1`, `1.001`, `"0"`, `"0.00"`, `"-1"`               |
| `"9999999999999999.99"`                   | `"10000000000000000"`, `"1.001"`                          |
| Ordinary decimal notation                 | `"1e3"`, `"NaN"`, `"Infinity"`, `"01"`, `" 1"`, `"1,000"` |

Returned amounts and balances always have two decimal places. PostgreSQL NUMERIC(18,2) performs the arithmetic; clients should retain decimal strings or use a decimal library instead of binary floating-point money arithmetic. A balance overflow causes an atomic database failure and a sanitized 500 response.

### Names, descriptions and references

| Field                                      | Rules                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `name`                                     | Required string; trimmed before validation; 1–200 characters after trimming                        |
| `description` on a posting request         | Optional string, maximum 2,000 characters; explicit null rejected                                  |
| `reference_id`                             | Required, nonblank string, maximum 200 characters; exact case and surrounding whitespace preserved |
| Unknown body fields                        | Rejected with 400                                                                                  |
| NUL or unpaired Unicode surrogates in text | Rejected with 400                                                                                  |

Missing, empty or whitespace-only posting descriptions become `Credit transaction` or `Debit transaction`. Supplied nonblank text is preserved. Transfers generate `Transfer to <destination name>` and `Transfer from <source name>` from the locked account records.

Every new ledger entry requires a nonblank description, enforced by the initial schema. Older installations may retain original null/blank historical descriptions; history and duplicate responses preserve those immutable values.

For standalone postings, a reference beginning with the exact prefix `transfer/` is rejected because that namespace belongs to generated transfer entries. Transfer **metadata** references use the general nonblank reference rules. Prefer opaque references or business-operation identifiers with a clear per-operation lifetime.

## Endpoint directory

| Method | Path                          | Success | Purpose                                      |
| ------ | ----------------------------- | ------- | -------------------------------------------- |
| POST   | `/accounts`                   | 201     | Create an account with zero balance          |
| GET    | `/accounts/{id}/balance`      | 200     | Read current balance                         |
| POST   | `/accounts/{id}/transactions` | 201     | Commit a credit or debit                     |
| GET    | `/accounts/{id}/transactions` | 200     | Read filtered, paginated immutable entries   |
| POST   | `/transfers`                  | 201     | Commit a linked debit/credit pair atomically |
| GET    | `/health`                     | 200     | Check process availability                   |
| GET    | `/ready`                      | 200     | Check database/schema read readiness         |

`GET /docs/`, `/docs/json` and `/docs/yaml` serve documentation and its contract. No account-list, account-details GET, account update, ledger update/delete, or transfer-details GET endpoint is implemented. An unregistered route or method returns 404 with `NOT_FOUND`.

## Create an account

`POST /accounts`

| Body field | Type   | Required | Behavior                                          |
| ---------- | ------ | -------- | ------------------------------------------------- |
| `name`     | string | Yes      | Account-holder name; trimmed and bounded as above |

The client cannot supply `id`, `balance` or `created_at`. Names do not have to be unique. PostgreSQL generates the UUID and timestamp; initial balance is always `0.00` through this API.

```bash
curl -sS -X POST http://127.0.0.1:3000/accounts \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice"}' | python3 -m json.tool
```

201 response:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "Alice",
  "balance": "0.00",
  "created_at": "2026-10-28T00:00:00.000Z"
}
```

| Failure                                                        | Status    | Code                                        |
| -------------------------------------------------------------- | --------- | ------------------------------------------- |
| Missing/blank/invalid name, unknown or system-controlled field | 400       | `VALIDATION_ERROR`                          |
| Oversized body / unsupported media type                        | 413 / 415 | `VALIDATION_ERROR`                          |
| Unexpected failure                                             | 500       | `DATABASE_ERROR` or `INTERNAL_SERVER_ERROR` |

Account creation has no reference-based idempotency key. Repeating a successful account-creation request creates a new account, even with the same name.

## Read an account balance

`GET /accounts/{id}/balance`

| Parameter | Location | Type        | Required |
| --------- | -------- | ----------- | -------- |
| `id`      | path     | UUID string | Yes      |

```bash
BASE_URL=http://127.0.0.1:3000
ACCOUNT_ID="replace-with-returned-account-uuid"
curl -sS "$BASE_URL/accounts/$ACCOUNT_ID/balance" | python3 -m json.tool
```

200 response:

```json
{
  "account_id": "11111111-1111-4111-8111-111111111111",
  "balance": "100.00"
}
```

Failures: 400 `INVALID_ACCOUNT_ID`, 404 `ACCOUNT_NOT_FOUND`, or sanitized 500. The response is the committed balance observed by this request; a later concurrent posting may change it.

## Post a credit or debit

`POST /accounts/{id}/transactions`

| Field          | Type                  | Required | Rules                                        |
| -------------- | --------------------- | -------- | -------------------------------------------- |
| `id`           | path UUID             | Yes      | Existing account                             |
| `type`         | body string           | Yes      | Exactly `credit` or `debit`                  |
| `amount`       | body string or number | Yes      | Positive, exact money format                 |
| `reference_id` | body string           | Yes      | Unique within this account                   |
| `description`  | body string           | No       | Preserved when nonblank; otherwise generated |

Credit example:

```bash
curl -sS -X POST "$BASE_URL/accounts/$ACCOUNT_ID/transactions" \
  -H 'Content-Type: application/json' \
  -d '{"type":"credit","amount":"100.00","description":"Initial deposit","reference_id":"deposit-001"}' \
  | python3 -m json.tool
```

201 response:

```json
{
  "id": "33333333-3333-4333-8333-333333333333",
  "account_id": "11111111-1111-4111-8111-111111111111",
  "type": "credit",
  "amount": "100.00",
  "description": "Initial deposit",
  "reference_id": "deposit-001",
  "created_at": "2026-10-28T00:01:00.000Z",
  "transfer_id": null
}
```

Debit example; its generated description is `Debit transaction`:

```bash
curl -sS -X POST "$BASE_URL/accounts/$ACCOUNT_ID/transactions" \
  -H 'Content-Type: application/json' \
  -d '{"type":"debit","amount":"20.00","reference_id":"withdrawal-001"}' \
  | python3 -m json.tool
```

A credit increases balance. A debit requires sufficient funds. The transaction insert and balance update are one database transaction. The response does not include an account balance; use the balance endpoint to read it.

| Failure                                                          | Status    | Code                                       |
| ---------------------------------------------------------------- | --------- | ------------------------------------------ |
| Invalid path UUID                                                | 400       | `INVALID_ACCOUNT_ID`                       |
| Invalid body, money, type, reference, description or extra field | 400       | `VALIDATION_ERROR`                         |
| Account missing                                                  | 404       | `ACCOUNT_NOT_FOUND`                        |
| Same account/reference already committed                         | 409       | `DUPLICATE_TRANSACTION`                    |
| Debit exceeds balance                                            | 422       | `INSUFFICIENT_BALANCE`                     |
| Body/media failure                                               | 413 / 415 | `VALIDATION_ERROR`                         |
| Database/unexpected failure                                      | 500       | `DATABASE_ERROR` / `INTERNAL_SERVER_ERROR` |

Validation precedes database access. After locking the account, the service checks duplicates before checking funds. A valid duplicate debit therefore returns 409 even if the newly submitted amount would exceed the current balance.

## Read transaction history

`GET /accounts/{id}/transactions`

| Query parameter | Type    | Default | Rules                                    |
| --------------- | ------- | ------- | ---------------------------------------- |
| `type`          | string  | absent  | `credit` or `debit`; absent returns both |
| `page`          | integer | 1       | Decimal digits only; 1–2,147,483,647     |
| `limit`         | integer | 20      | Decimal digits only; 1–100               |

Empty, signed, fractional, exponent, repeated or out-of-range pagination values are rejected. Unknown query properties are rejected. Invalid query fields, including `type`, return `INVALID_PAGINATION`. Path UUID validation happens first; query validation happens before the account existence check.

```bash
curl -sS "$BASE_URL/accounts/$ACCOUNT_ID/transactions?type=credit&page=1&limit=20" \
  | python3 -m json.tool
```

200 response:

```json
{
  "data": [
    {
      "id": "33333333-3333-4333-8333-333333333333",
      "account_id": "11111111-1111-4111-8111-111111111111",
      "type": "credit",
      "amount": "100.00",
      "description": "Initial deposit",
      "reference_id": "deposit-001",
      "created_at": "2026-10-28T00:01:00.000Z",
      "transfer_id": null
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total_records": 1, "total_pages": 1 }
}
```

`total_records` and `total_pages` use the same type filter as `data`. Empty histories return an empty array and zero total pages. A page beyond the end returns an empty array while preserving the filtered totals. Results sort by PostgreSQL `created_at DESC, id DESC`.

This is offset pagination. Account existence, count and page queries share one REPEATABLE READ READ ONLY transaction, so totals and data use the same committed snapshot. Pagination is not a stable export snapshot; concurrent inserts may shift entries between pages.

Failures: 400 `INVALID_ACCOUNT_ID` or `INVALID_PAGINATION`, 404 `ACCOUNT_NOT_FOUND`, or sanitized 500.

## Transfer money

`POST /transfers`

| Body field        | Type             | Required | Rules                                        |
| ----------------- | ---------------- | -------- | -------------------------------------------- |
| `from_account_id` | UUID string      | Yes      | Existing source account                      |
| `to_account_id`   | UUID string      | Yes      | Existing, different destination account      |
| `amount`          | string or number | Yes      | Positive exact money; source must have funds |
| `reference_id`    | string           | Yes      | Unique for this source account's transfers   |

Descriptions are generated by the backend. A `description` property in the transfer request is an unknown field and is rejected.

```bash
SOURCE_ID="replace-with-source-uuid"
DESTINATION_ID="replace-with-destination-uuid"
curl -sS -X POST "$BASE_URL/transfers" \
  -H 'Content-Type: application/json' \
  -d "{\"from_account_id\":\"$SOURCE_ID\",\"to_account_id\":\"$DESTINATION_ID\",\"amount\":\"30.00\",\"reference_id\":\"transfer-001\"}" \
  | python3 -m json.tool
```

201 response:

```json
{
  "id": "55555555-5555-4555-8555-555555555555",
  "from_account_id": "11111111-1111-4111-8111-111111111111",
  "to_account_id": "22222222-2222-4222-8222-222222222222",
  "amount": "30.00",
  "reference_id": "transfer-001",
  "created_at": "2026-10-28T00:03:00.000Z",
  "transactions": [
    {
      "id": "66666666-6666-4666-8666-666666666666",
      "account_id": "11111111-1111-4111-8111-111111111111",
      "type": "debit",
      "amount": "30.00",
      "description": "Transfer to Bob",
      "reference_id": "transfer/55555555-5555-4555-8555-555555555555/debit",
      "created_at": "2026-10-28T00:03:00.001Z",
      "transfer_id": "55555555-5555-4555-8555-555555555555"
    },
    {
      "id": "77777777-7777-4777-8777-777777777777",
      "account_id": "22222222-2222-4222-8222-222222222222",
      "type": "credit",
      "amount": "30.00",
      "description": "Transfer from Alice",
      "reference_id": "transfer/55555555-5555-4555-8555-555555555555/credit",
      "created_at": "2026-10-28T00:03:00.002Z",
      "transfer_id": "55555555-5555-4555-8555-555555555555"
    }
  ]
}
```

The two entries share the metadata ID in `transfer_id`. `transactions[0]` is the source debit and `[1]` the destination credit. The request's user reference belongs to transfer metadata; the generated ledger references are different. Both account histories include their corresponding entry.

The response contains transfer metadata and entries, not updated balances. In the quick-start workflow, source 80 and destination 50 become 50 and 80 after this transfer. Use each account's balance endpoint to verify the resulting state.

| Failure                                                                          | Status    | Code                                       |
| -------------------------------------------------------------------------------- | --------- | ------------------------------------------ |
| Invalid UUID/body/money/reference, same account after normalization, extra field | 400       | `VALIDATION_ERROR`                         |
| Either account missing                                                           | 404       | `ACCOUNT_NOT_FOUND`                        |
| Source/reference already exists                                                  | 409       | `DUPLICATE_TRANSFER`                       |
| Source funds insufficient                                                        | 422       | `INSUFFICIENT_BALANCE`                     |
| Body/media failure                                                               | 413 / 415 | `VALIDATION_ERROR`                         |
| Database/unexpected failure                                                      | 500       | `DATABASE_ERROR` / `INTERNAL_SERVER_ERROR` |

All body validation and both existence checks precede the duplicate lookup. If both accounts exist and the request is otherwise valid, the same source/reference is a duplicate even when its new amount or destination differs. Same-reference transfers from different source accounts are allowed.

## Health and readiness

```bash
curl -sS "$BASE_URL/health" | python3 -m json.tool
curl -sS "$BASE_URL/ready" | python3 -m json.tool
```

| Endpoint  | 200 body             | Database dependency                                            |
| --------- | -------------------- | -------------------------------------------------------------- |
| `/health` | `{"status":"ok"}`    | None                                                           |
| `/ready`  | `{"status":"ready"}` | Connectivity and read access to required ledger tables/columns |

Unavailable database or required schema returns 503:

```json
{
  "error": {
    "code": "DATABASE_UNAVAILABLE",
    "message": "Database is unavailable",
    "details": []
  }
}
```

Readiness is a read check. It is not a full test of write privileges, sufficient account balances or every integrity constraint. No `Retry-After` policy is configured.

## Error reference

Every application error has this envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": [
      { "path": "amount", "message": "Amount must be greater than zero" }
    ]
  }
}
```

The example is the response to an amount of `"0"`. Use `code` and HTTP status for program logic; human-readable validation messages may change with dependency updates. Validation `details` identify paths and messages and do not echo raw input values.

| Status | Code                    | Meaning / handling                                                                   |
| ------ | ----------------------- | ------------------------------------------------------------------------------------ |
| 400    | `VALIDATION_ERROR`      | Fix the request body or transfer input                                               |
| 400    | `INVALID_ACCOUNT_ID`    | Fix account path UUID syntax                                                         |
| 400    | `INVALID_PAGINATION`    | Fix history query fields                                                             |
| 404    | `ACCOUNT_NOT_FOUND`     | Requested source/account/destination is missing                                      |
| 404    | `NOT_FOUND`             | Route/method is not registered                                                       |
| 409    | `DUPLICATE_TRANSACTION` | Inspect original transaction in `details[0]`; do not post a second reference blindly |
| 409    | `DUPLICATE_TRANSFER`    | Inspect original transfer metadata in `details[0]`                                   |
| 413    | `VALIDATION_ERROR`      | Reduce request body below 16 KiB                                                     |
| 415    | `VALIDATION_ERROR`      | Send a supported JSON content type                                                   |
| 422    | `INSUFFICIENT_BALANCE`  | Confirm funds and intended amount; no posting committed                              |
| 500    | `DATABASE_ERROR`        | Sanitized database failure; consider commit uncertainty below                        |
| 500    | `INTERNAL_SERVER_ERROR` | Sanitized unexpected failure; consider commit uncertainty below                      |
| 503    | `DATABASE_UNAVAILABLE`  | `/ready` could not verify database/schema access                                     |

Except for validation issues and duplicate resources, `details` is an empty array. A malformed JSON/body/media error uses the message `Invalid request body or content type`. Insufficient funds uses `Insufficient balance for this debit`, including for transfers. Unavailable routes return 404 rather than 405.

### Duplicate posting example

```json
{
  "error": {
    "code": "DUPLICATE_TRANSACTION",
    "message": "A transaction with this reference already exists",
    "details": [
      {
        "id": "33333333-3333-4333-8333-333333333333",
        "account_id": "11111111-1111-4111-8111-111111111111",
        "type": "credit",
        "amount": "100.00",
        "description": "Initial deposit",
        "reference_id": "deposit-001",
        "created_at": "2026-10-28T00:01:00.000Z",
        "transfer_id": null
      }
    ]
  }
}
```

A duplicate transfer's `details[0]` contains metadata fields `id`, `from_account_id`, `to_account_id`, `amount`, `reference_id`, `created_at`; it does not include the `transactions` array from a successful 201 response.

## Idempotency and failure recovery

| Operation      | Duplicate scope                   | Duplicate response                  |
| -------------- | --------------------------------- | ----------------------------------- |
| Create account | No reference-based deduplication  | Another account may be created      |
| Add posting    | `(account_id, reference_id)`      | 409 with original ledger entry      |
| Transfer       | `(from_account_id, reference_id)` | 409 with original transfer metadata |

`reference_id` belongs in the JSON body; there is no `Idempotency-Key` header contract. A transfer reference and a standalone-posting reference are separate namespaces. Reference matching is exact and case-sensitive; the JSON strings `"Ref"`, `"ref"` and `" ref "` differ.

Choose one reference per intended posting/transfer and retain the entire intended payload. On a timeout, connection loss or ambiguous 500:

1. Keep the same reference. Do not generate another reference just to retry.
2. Resubmit the same valid payload when the service is reachable.
3. If 201, the operation has now committed. If 409, compare the original resource in `details[0]` with the intended operation.
4. A 409 alone does not prove the newly submitted amount/type/destination was applied; the reference may have been reused with different data.
5. Investigate mismatches before taking another financial action.

Rejected 400/404/409/422 requests do not create new financial state. Operations confirmed to have rolled back, such as a balance overflow, do not persist their preceding insert. A network failure around COMMIT can have an **unknown outcome**, even when the client observes an error; a 500 or dropped connection is not universal proof that nothing committed. The backend performs no automatic write retry.

## Consistency and immutability

Mutation requests use one PostgreSQL transaction and account row locks. Unrelated accounts can post independently. Transfer account locks are acquired sequentially in normalized UUID order, preventing opposing API transfers from acquiring the two account locks in opposite order.

A committed transfer has one metadata record and exactly two linked ledger entries. Both balance changes and both entries commit together or roll back together. The combined source/destination balance is conserved by a transfer. An overdraft or a failure in either leg leaves the operation uncommitted.

Ledger entries have no update/delete endpoint. Database triggers also reject UPDATE/DELETE, and runtime permissions exclude those operations. Corrections require a new authorized posting/reference; there is no reversal-specific API. Privileged database owners remain trusted and can alter database protections.

Balances are stored projections. For each account, the stored balance must equal the sum of credits minus debits. Verification tests reconcile both account totals and transfer pairs; the service does not silently repair a mismatch.

## Client examples

### Node.js fetch

This example uses a caller-supplied reference so the application can preserve it across an uncertain outcome. The caller must handle 409 by inspecting the original resource.

```javascript
async function postCredit(baseUrl, accountId, amount, referenceId) {
  const response = await fetch(
    `${baseUrl}/accounts/${encodeURIComponent(accountId)}/transactions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'credit',
        amount,
        reference_id: referenceId,
      }),
    },
  );
  const body = await response.json();
  if (response.status === 201) return { created: true, transaction: body };
  if (response.status === 409 && body.error.code === 'DUPLICATE_TRANSACTION') {
    return { created: false, transaction: body.error.details[0] };
  }
  throw Object.assign(new Error(body.error.message), {
    status: response.status,
    code: body.error.code,
    details: body.error.details,
  });
}
```

A network exception must be handled by the caller using the same saved reference; this function does not automatically retry or assume rollback. Returned money remains a string.

### Python requests

Install `requests` in your client environment if needed. The server itself has no Python dependency.

```python
import requests

base_url = "http://127.0.0.1:3000"
account_id = "replace-with-returned-account-uuid"

response = requests.get(
    f"{base_url}/accounts/{account_id}/transactions",
    params={"type": "debit", "page": 1, "limit": 20},
    timeout=35,
)
body = response.json()
response.raise_for_status()
for entry in body["data"]:
    print(entry["amount"], entry["description"])
```

The client timeout is a client choice, not a server-side overall deadline or cancellation guarantee. Do not apply the same retry policy blindly to account creation and money mutations.

## Operational behavior and compatibility

- Configuration validates before listening. Startup verifies database/schema read access, enforced integrity constraints and enabled immutability triggers; migrations are applied separately.
- One connection pool is shared per process. Defaults: maximum 10 clients, connection/acquisition timeout 10 seconds, idle timeout 30 seconds, statement timeout 30 seconds and lock timeout 5 seconds.
- Statement timeout applies per SQL statement. These values do not define a guaranteed end-to-end HTTP deadline or service-level objective.
- SIGINT/SIGTERM closes the server and pool. Clients must still reconcile interrupted mutation outcomes using their original references.
- Account IDs and creation timestamps are generated by PostgreSQL. Client applications should treat generated IDs and historical field values as immutable.
- There is no authentication, rate-limit, request-ID response-header or automatic retry contract. No 401, 403 or 429 behavior is advertised by these application routes.
- OpenAPI and this reference are versioned with the source. Paths remain unversioned in implementation; this document does not promise a separate version-negotiation or deprecation mechanism.

Validate documentation with `npm run docs:validate`; exercise the collection against an isolated database with `npm run test:docs`. Documentation HTTP routes and examples are included in automated verification. Hosted deployment, external access control and remote TLS remain separately configured concerns.
