import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv, type Schema, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { OpenAPIV3 } from 'openapi-types';

export async function loadContract() {
  const document = (await SwaggerParser.validate(
    'openapi.yaml',
  )) as OpenAPIV3.Document;
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: true,
  });
  addFormats.default(ajv);
  const cache = new Map<object, ValidateFunction>();
  const assertSchema = (schema: object, value: unknown, label: string) => {
    let validate = cache.get(schema);
    if (!validate) {
      validate = ajv.compile(schema as Schema);
      cache.set(schema, validate);
    }
    if (!validate(value))
      throw new Error(
        `${label}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`,
      );
  };
  const operation = (method: string, url: string) => {
    const pathname = new URL(url, 'http://localhost').pathname;
    for (const [path, item] of Object.entries(document.paths)) {
      const pattern = new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`);
      const found = item?.[method.toLowerCase() as OpenAPIV3.HttpMethods];
      if (pattern.test(pathname) && found) return { path, operation: found };
    }
    throw new Error(`Undocumented operation: ${method} ${pathname}`);
  };
  return { document, assertSchema, operation };
}
