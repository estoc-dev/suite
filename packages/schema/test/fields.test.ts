import type { EncodedObject, Est, EstLink } from "@estoc/object";
import { describe, expectTypeOf, it } from "vitest";
import { any, array, boolean, bytes, type DataOf, integer, link, optional, schema, string } from "../src/index.ts";

const note = schema("Note", {
  text: string(),
  at: integer(),
  key: bytes(),
  rows: array(array(integer())),
  isDraft: optional(boolean()),
  tags: optional(array(string())),
  more: optional(any()),
});

// Two schemas whose objects link to each other, each read as the data of its own.
interface Identity extends EncodedObject<Est, DataOf<typeof identity>> {}
interface SignedIdentity extends EncodedObject<Est, DataOf<typeof signedIdentity>> {}
const identity = schema("Identity", { at: integer(), prior: optional(link<SignedIdentity>()) });
const signedIdentity = schema("Signed Identity", { identity: link<Identity>(), signature: bytes() });

describe("DataOf", () => {
  it("reads each field as its type, and an optional one as a member that may be left out", () => {
    expectTypeOf<DataOf<typeof note>>().toEqualTypeOf<{
      readonly text: string;
      readonly at: number;
      readonly key: Uint8Array;
      readonly rows: readonly (readonly number[])[];
      readonly isDraft?: boolean;
      readonly tags?: readonly string[];
      readonly more?: Est;
    }>();
  });

  it("reads a link as one to what the schema's program says it names", () => {
    expectTypeOf<DataOf<typeof identity>>().toEqualTypeOf<{
      readonly at: number;
      readonly prior?: EstLink<SignedIdentity>;
    }>();
    expectTypeOf<DataOf<typeof signedIdentity>["identity"]>().toEqualTypeOf<EstLink<Identity>>();
  });
});

describe("optional", () => {
  it("marks a field, and not the items of an array or a field twice", () => {
    // @ts-expect-error: the items of an array are not optional
    array(optional(string()));
    // @ts-expect-error: a field is optional once
    optional(optional(string()));
  });
});
