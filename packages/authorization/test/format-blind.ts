import type { SchemaValidator } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";

/** Asserts all that the default validator does except `format`, which a validator may leave alone. */
export const formatBlind: SchemaValidator = {
  compile: (schema) =>
    defaultValidator.compile(JSON.parse(JSON.stringify(schema, (key, value) => (key === "format" ? undefined : value)))),
};
