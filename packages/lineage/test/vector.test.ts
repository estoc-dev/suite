import { linkOf } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it, test } from "vitest";
import { loadLineage } from "../src/index.ts";

// The bytes and links were checked against Python's json module with sorted
// keys and no whitespace, which writes these values as JCS does, and against
// its hashlib. A change to the format changes them.
const schemaText =
  '{"$schema":{"$link":"sha256:425b8e0a2f53217063bea3514e27175e0f1aa4b046ca12b4a65020e391e33326"},' +
  '"document":{"$schema":"https://json-schema.org/draft/2020-12/schema","additionalProperties":false,' +
  '"properties":{"item":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"},' +
  '"previous":{"additionalProperties":{"pattern":"^sha256:[0-9a-f]{64}$","type":"string"},' +
  '"propertyNames":{"const":"$link"},"required":["$link"],"type":"object"}},"required":["item"],' +
  '"title":"Lineage Node","type":"object"}}';
const schemaLink = "sha256:01c55a1bcd1d4c979d723722e89c45dbe3b065c8619e5417e68e4df3a2da4717";
const firstText =
  '{"$schema":{"$link":"sha256:01c55a1bcd1d4c979d723722e89c45dbe3b065c8619e5417e68e4df3a2da4717"},' +
  '"item":{"$link":"sha256:b19f8edae2ee6c225b7278b289c2823ab9accfa225c5d67c4bef270b88ea55f0"}}';
const firstLink = "sha256:282dc35f9aba8f0801663007fc30c3632fed2d411a44515f7c1895adb57e1929";
const secondText =
  '{"$schema":{"$link":"sha256:01c55a1bcd1d4c979d723722e89c45dbe3b065c8619e5417e68e4df3a2da4717"},' +
  '"item":{"$link":"sha256:f4761aa023c3639dc371a2336ee3514ab6236bad28c5a0ebf2e52fb6e42030d1"},' +
  '"previous":{"$link":"sha256:282dc35f9aba8f0801663007fc30c3632fed2d411a44515f7c1895adb57e1929"}}';
const secondLink = "sha256:bafcadd2600541595ae1c9d0520bbfb1f2382a0a9ee250d4e93904f1f75b4407";

const lineages = await loadLineage(defaultValidator);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (text: string) => new TextEncoder().encode(text);

test("the lineage node schema encodes to fixed bytes and a fixed link", () => {
  expect(text(lineages.schema.bytes)).toBe(schemaText);
  expect(lineages.schema.link).toBe(schemaLink);
});

describe("a lineage of the blobs 'version 1' and 'version 2'", () => {
  it("encodes its nodes to fixed bytes and links", () => {
    const lineage = lineages
      .startingWith({ link: linkOf(utf8("version 1")) })
      .appending({ link: linkOf(utf8("version 2")) });
    expect(lineage.nodes.map(({ bytes }) => text(bytes))).toEqual([firstText, secondText]);
    expect(lineage.nodes.map(({ link }) => link)).toEqual([firstLink, secondLink]);
  });
});
