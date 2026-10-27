import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parse } from 'yaml';

export interface CollectionItem {
  name: string;
  request: {
    method: 'GET' | 'POST';
    url: string;
    description: string;
    header: { key: string; value: string }[];
    body?: { mode: 'raw'; raw: string; options: { raw: { language: 'json' } } };
  };
  event: {
    listen: 'prerequest' | 'test';
    script: { type: string; exec: string[] };
  }[];
}
export interface Collection {
  info: { name: string; schema: string; description: string };
  auth: { type: 'noauth' };
  variable: { key: string; value: string; type: string }[];
  item: CollectionItem[];
}
export const collectionPath = 'docs/postman/Confluencr.postman_collection.json';
export const environmentPath = 'docs/postman/Local.postman_environment.json';

export async function postmanArtifacts() {
  const spec = parse(await readFile('openapi.yaml', 'utf8')) as {
    components: {
      examples: Record<string, { value: Record<string, unknown> }>;
    };
  };
  const example = (name: string) => {
    const value = spec.components.examples[name]?.value;
    if (!value) throw new Error(`Missing canonical OpenAPI example: ${name}`);
    return value;
  };
  const collection: Collection = {
    info: {
      name: 'Confluencr Transaction Ledger API',
      schema:
        'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description:
        'Contract version 1.0.0. Run in listed order against a development database. Creates fresh Alice/Bob accounts, captures IDs and generates a new run_id for reference isolation. Final balances: Alice 50.00 / Bob 80.00. Re-running creates another pair of accounts; no ledger history is deleted. No authentication is implemented. See docs/API_REFERENCE.md for failure recovery and exact error semantics. Generated from scripts/postman.ts and openapi.yaml; regenerate with npm run docs:generate.',
    },
    auth: { type: 'noauth' },
    variable: [
      { key: 'base_url', value: 'http://127.0.0.1:3000', type: 'string' },
      { key: 'run_id', value: '', type: 'string' },
      { key: 'source_account_id', value: '', type: 'string' },
      { key: 'destination_account_id', value: '', type: 'string' },
    ],
    item: [],
  };
  const add = (
    name: string,
    method: 'GET' | 'POST',
    path: string,
    status: number,
    checks: string[] = [],
    body?: Record<string, unknown>,
    description = '',
  ) => {
    const item: CollectionItem = {
      name,
      request: {
        method,
        url: `{{base_url}}${path}`,
        description: description || name,
        header: body
          ? [{ key: 'Content-Type', value: 'application/json' }]
          : [],
        ...(body
          ? {
              body: {
                mode: 'raw' as const,
                raw: JSON.stringify(body, null, 2),
                options: { raw: { language: 'json' as const } },
              },
            }
          : {}),
      },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [
              `pm.test(${JSON.stringify(`${name}: HTTP ${status}`)}, function () { pm.response.to.have.status(${status}); });`,
              'const body = pm.response.json();',
              ...(checks.length
                ? [
                    `pm.test(${JSON.stringify(`${name}: response contract`)}, function () {`,
                    ...checks.map((line) => `  ${line}`),
                    '});',
                  ]
                : []),
            ],
          },
        },
      ],
    };
    collection.item.push(item);
    return item;
  };
  const source = '/accounts/{{source_account_id}}';
  const destination = '/accounts/{{destination_account_id}}';
  const credit = {
    ...example('CreditInput'),
    reference_id: 'docs-{{run_id}}-deposit',
  };
  const debit: Record<string, unknown> = {
    ...example('DebitInput'),
    reference_id: 'docs-{{run_id}}-withdrawal',
  };
  // Omit description intentionally: the backend must generate its default.
  delete debit.description;
  const transfer = {
    ...example('TransferInput'),
    from_account_id: '{{source_account_id}}',
    to_account_id: '{{destination_account_id}}',
    reference_id: 'docs-{{run_id}}-transfer',
  };
  const health = add('01 Health and initialize run', 'GET', '/health', 200, [
    'pm.expect(body.status).to.equal("ok");',
  ]);
  health.event.unshift({
    listen: 'prerequest',
    script: {
      type: 'text/javascript',
      exec: [
        'pm.collectionVariables.set("run_id", pm.variables.replaceIn("{{$guid}}"));',
        'pm.collectionVariables.unset("source_account_id");',
        'pm.collectionVariables.unset("destination_account_id");',
      ],
    },
  });
  add('02 Database readiness', 'GET', '/ready', 200, [
    'pm.expect(body.status).to.equal("ready");',
  ]);
  for (const [number, name, key] of [
    ['03', 'Alice', 'source_account_id'],
    ['04', 'Bob', 'destination_account_id'],
  ]) {
    add(
      `${number} Create ${name}`,
      'POST',
      '/accounts',
      201,
      [
        `pm.expect(body.name).to.equal(${JSON.stringify(name)});`,
        'pm.expect(body.balance).to.equal("0.00");',
        'pm.expect(body.id).to.match(/^[0-9a-f-]{36}$/);',
        `pm.collectionVariables.set(${JSON.stringify(key)}, body.id);`,
      ],
      example(`Create${name}`),
    );
  }
  add(
    '05 Credit Alice 100',
    'POST',
    `${source}/transactions`,
    201,
    [
      'pm.expect(body.amount).to.equal("100.00");',
      'pm.expect(body.description).to.equal("Initial deposit");',
      'pm.expect(body.transfer_id).to.equal(null);',
    ],
    credit,
  );
  add(
    '06 Credit Bob 50 with same account-scoped reference',
    'POST',
    `${destination}/transactions`,
    201,
    ['pm.expect(body.amount).to.equal("50.00");'],
    { ...credit, amount: '50.00' },
  );
  add(
    '07 Debit Alice 20 with generated description',
    'POST',
    `${source}/transactions`,
    201,
    [
      'pm.expect(body.amount).to.equal("20.00");',
      'pm.expect(body.description).to.equal("Debit transaction");',
    ],
    debit,
  );
  add('08 Alice balance before transfer', 'GET', `${source}/balance`, 200, [
    'pm.expect(body.balance).to.equal("80.00");',
  ]);
  add(
    '09 Transfer 30 from Alice to Bob',
    'POST',
    '/transfers',
    201,
    [
      'pm.expect(body.amount).to.equal("30.00");',
      'pm.expect(body.transactions).to.have.length(2);',
      'pm.expect(body.transactions.map(t => t.type)).to.deep.equal(["debit", "credit"]);',
      'pm.expect(body.transactions.map(t => t.description)).to.deep.equal(["Transfer to Bob", "Transfer from Alice"]);',
      'body.transactions.forEach(t => { pm.expect(t.transfer_id).to.equal(body.id); pm.expect(t.amount).to.equal("30.00"); });',
    ],
    transfer,
  );
  add('10 Alice final balance', 'GET', `${source}/balance`, 200, [
    'pm.expect(body.balance).to.equal("50.00");',
  ]);
  add('11 Bob final balance', 'GET', `${destination}/balance`, 200, [
    'pm.expect(body.balance).to.equal("80.00");',
  ]);
  add(
    '12 Alice history page 1',
    'GET',
    `${source}/transactions?page=1&limit=2`,
    200,
    [
      'pm.expect(body.data).to.have.length(2);',
      'pm.expect(body.pagination).to.deep.equal({page: 1, limit: 2, total_records: 3, total_pages: 2});',
      'pm.expect(body.data.map(t => t.type)).to.deep.equal(["debit", "debit"]);',
    ],
  );
  add(
    '13 Alice history page 2',
    'GET',
    `${source}/transactions?page=2&limit=2`,
    200,
    [
      'pm.expect(body.data).to.have.length(1);',
      'pm.expect(body.data[0].type).to.equal("credit");',
    ],
  );
  add(
    '14 Alice credit filter',
    'GET',
    `${source}/transactions?type=credit&page=1&limit=20`,
    200,
    [
      'pm.expect(body.pagination.total_records).to.equal(1);',
      'pm.expect(body.data[0].type).to.equal("credit");',
    ],
  );
  add(
    '15 Alice debit filter',
    'GET',
    `${source}/transactions?type=debit&page=1&limit=20`,
    200,
    [
      'pm.expect(body.pagination.total_records).to.equal(2);',
      'pm.expect(body.data.every(t => t.type === "debit")).to.equal(true);',
    ],
  );
  add(
    '16 Duplicate posting returns original',
    'POST',
    `${source}/transactions`,
    409,
    [
      'pm.expect(body.error.code).to.equal("DUPLICATE_TRANSACTION");',
      'pm.expect(body.error.details[0].amount).to.equal("100.00");',
    ],
    credit,
  );
  add(
    '17 Duplicate transfer returns metadata',
    'POST',
    '/transfers',
    409,
    [
      'pm.expect(body.error.code).to.equal("DUPLICATE_TRANSFER");',
      'pm.expect(body.error.details[0].amount).to.equal("30.00");',
      'pm.expect(body.error.details[0]).not.to.have.property("transactions");',
    ],
    transfer,
  );
  add(
    '18 Reject overdraft',
    'POST',
    `${source}/transactions`,
    422,
    ['pm.expect(body.error.code).to.equal("INSUFFICIENT_BALANCE");'],
    { ...debit, amount: '51.00', reference_id: 'docs-{{run_id}}-overdraft' },
  );
  add(
    '19 Reject zero amount',
    'POST',
    `${source}/transactions`,
    400,
    [
      'pm.expect(body.error.code).to.equal("VALIDATION_ERROR");',
      'pm.expect(body.error.details[0].path).to.equal("amount");',
    ],
    { ...credit, amount: '0', reference_id: 'docs-{{run_id}}-zero' },
  );
  add(
    '20 Reject invalid account UUID',
    'GET',
    '/accounts/not-a-uuid/balance',
    400,
    ['pm.expect(body.error.code).to.equal("INVALID_ACCOUNT_ID");'],
  );
  add(
    '21 Missing account',
    'GET',
    '/accounts/00000000-0000-4000-8000-000000000000/balance',
    404,
    ['pm.expect(body.error.code).to.equal("ACCOUNT_NOT_FOUND");'],
  );
  add(
    '22 Rejected writes leave history unchanged',
    'GET',
    `${source}/transactions?page=1&limit=20`,
    200,
    [
      'pm.expect(body.pagination.total_records).to.equal(3);',
      'pm.expect(body.data.every(t => typeof t.description === "string" && t.description.trim().length > 0)).to.equal(true);',
    ],
  );
  add('23 Alice balance remains 50', 'GET', `${source}/balance`, 200, [
    'pm.expect(body.balance).to.equal("50.00");',
  ]);
  add('24 Bob balance remains 80', 'GET', `${destination}/balance`, 200, [
    'pm.expect(body.balance).to.equal("80.00");',
  ]);
  const environment = {
    name: 'Confluencr Local',
    values: [
      {
        key: 'base_url',
        value: 'http://127.0.0.1:3000',
        type: 'default',
        enabled: true,
      },
    ],
    _postman_variable_scope: 'environment',
  };
  return new Map([
    [collectionPath, JSON.stringify(collection, null, 2) + '\n'],
    [environmentPath, JSON.stringify(environment, null, 2) + '\n'],
  ]);
}

export async function generatePostman(check = false) {
  for (const [path, expected] of await postmanArtifacts()) {
    if (check) {
      if ((await readFile(path, 'utf8')) !== expected)
        throw new Error(
          `Stale Postman artifact: ${path}; run npm run docs:generate`,
        );
    } else {
      await mkdir('docs/postman', { recursive: true });
      await writeFile(path, expected);
    }
  }
}
