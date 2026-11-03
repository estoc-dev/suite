import { encodeSchema, linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { expect, test } from "vitest";
import { commentSchema, loadComments } from "../src/index.ts";

// The bytes and the links were checked against Python's json module with
// sorted keys and no whitespace, which writes these values as JCS does, and
// its hashlib. A change to the format changes them.
const schemaText =
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"at":{"minimum":0,"type":"integer"},' +
  '"on":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"text":{"minLength":1,"type":"string"}},' +
  '"required":["on","text","at"],"title":"Comment","type":"object"}';
const schemaLink = "sha256:21446444a02886514d9fe18479b3a6c23f1d7a4063b43279a1861c0e202f1438";
const commentText =
  '{"$describedBy":{"$link":"sha256:21446444a02886514d9fe18479b3a6c23f1d7a4063b43279a1861c0e202f1438"},' +
  '"at":1700000000000,' +
  '"on":{"$link":"sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},' +
  '"text":"looks right"}';
const commentLink = "sha256:b72bb58fdee548e515ee5ff78674235f3df95627a82432a21afd2c7fb643ecc4";

test("the comment schema encodes to fixed bytes and a fixed link", async () => {
  const schema = await encodeSchema(commentSchema, defaultValidator);
  expect(new TextDecoder().decode(schema.bytes)).toBe(schemaText);
  expect(schema.link).toBe(schemaLink);
});

test("a comment encodes to fixed bytes and a fixed link", async () => {
  const comments = await loadComments({ validator: defaultValidator });
  const on = linkOf(new TextEncoder().encode("hello"));
  const comment = comments.encode(on, "looks right", 1_700_000_000_000);
  expect(new TextDecoder().decode(comment.bytes)).toBe(commentText);
  expect(comment.link).toBe(commentLink);
});
