import { removeUriSchemePlugin } from "@hyperjump/browser";
import {
  hasSchema,
  registerSchema,
  type SchemaObject,
  setShouldValidateFormat,
  unregisterSchema,
} from "@hyperjump/json-schema/draft-2020-12";
// The experimental API can change in a minor release, so the version is pinned exactly.
import {
  BASIC,
  compile,
  getSchema,
  interpret,
  type SchemaDocument,
} from "@hyperjump/json-schema/experimental";
import "@hyperjump/json-schema/formats-lite";
import { fromJs } from "@hyperjump/json-schema/instance/experimental";
import type { Json } from "./json.ts";
import {
  DRAFT_2020_12,
  type JsonSchema,
  type JsonSchemaValidator,
  jsonSchema,
} from "./json-schema.ts";
import type { Check } from "./schema.ts";

// hyperjump keeps one registry and one configuration for the whole realm.
// Without these plugins it has nowhere to fetch a schema from, so a `$ref`
// that names nothing registered fails compilation.
for (const scheme of ["http", "https", "file"]) removeUriSchemePlugin(scheme);
setShouldValidateFormat(true);

// Where a schema is registered while it compiles, and so the base a schema
// without `$id` resolves against. A URN admits fragments only, so a relative
// reference names nothing.
const anonymous = "urn:estoc:schema";

// A schema compiles while it sits in the registry, where another schema
// compiling at the same time could reach it; so schemas take turns.
let turn: Promise<unknown> = Promise.resolve();

/**
 * Validates draft 2020-12 with `@hyperjump/json-schema`, which interprets
 * schemas instead of generating code and so runs under a strict content
 * security policy. It asserts `format`, and passes formats it does not know.
 */
export const defaultValidator: JsonSchemaValidator = {
  language: jsonSchema,
  compile(schema) {
    const check = turn.then(() => compileRegistered(schema));
    turn = check.catch(() => undefined);
    return check;
  },
};

async function compileRegistered(schema: JsonSchema): Promise<Check<Json>> {
  if (schema.$schema !== DRAFT_2020_12) throw new Error(`unsupported dialect ${schema.$schema}`);
  registerSchema(schema as SchemaObject, anonymous);
  try {
    const root = await getSchema(anonymous);
    const resources = Object.entries(root.document.embedded ?? {}) as [string, SchemaDocument][];
    for (const [uri, resource] of resources) {
      // The registry resolves a URI before the schema's own resources do.
      if (uri !== anonymous && hasSchema(uri))
        throw new Error(`the schema takes the $id ${uri} of another schema`);
      if (resource.dialectId !== DRAFT_2020_12)
        throw new Error(`unsupported dialect ${resource.dialectId} in ${uri}`);
    }

    const compiled = await compile(root);
    // The meta-schemas are registered too, and resolve where nothing else would.
    const reachable = new Set(resources.map(([uri]) => uri));
    for (const location of Object.keys(compiled.ast)) {
      if (location === "metaData" || location === "plugins") continue;
      const uri = location.replace(/#.*/, "");
      if (!reachable.has(uri)) throw new Error(`$ref to ${uri}, which is not in the schema`);
    }

    return (data) => {
      const output = interpret(compiled, fromJs(data as Parameters<typeof fromJs>[0]), BASIC);
      if (output.valid) return [];
      const problems = (output.errors ?? []).map(
        ({ instanceLocation, absoluteKeywordLocation }) =>
          `${instanceLocation}: ${absoluteKeywordLocation}`,
      );
      // An empty list would read as a fit.
      return problems.length > 0 ? problems : ["#: does not fit"];
    };
  } finally {
    unregisterSchema(anonymous);
  }
}
