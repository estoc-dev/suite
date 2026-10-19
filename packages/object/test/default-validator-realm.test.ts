import "@hyperjump/json-schema/draft-07";
import { expect, test } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import { encodeSchema } from "../src/index.ts";

test("the default validator takes draft 2020-12 only, whatever other dialects hyperjump has loaded", async () => {
  const child = { $id: "https://example.com/child", $schema: "http://json-schema.org/draft-07/schema#", type: "string" };
  const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", $ref: "https://example.com/child", $defs: { child } };
  await expect(encodeSchema(schema, defaultValidator)).rejects.toThrow();
});
