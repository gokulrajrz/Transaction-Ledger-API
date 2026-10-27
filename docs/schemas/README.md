# Documentation validation schemas

`postman-collection-v2.1.schema.json` is the official Postman Collection v2.1 JSON Schema, retrieved from <https://schema.getpostman.com/json/collection/v2.1.0/collection.json>. It uses JSON Schema draft-04 and is vendored so documentation checks require no network access.

The collection generator lives in `scripts/postman.ts`. Run `npm run docs:generate` after changing its workflow or the canonical OpenAPI examples. `npm run docs:validate` checks the exported collection against this schema and rejects stale generated artifacts. `npm run test:docs` executes the ordered requests and assertions through a local contract harness against an isolated real PostgreSQL database; it does not launch the Postman desktop app.
