import { encodeObject, encodeSchema, type Json, linkOf, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { ed25519, eip191, loadIdentity, type Scheme, type SignedIdentityObject, SoftwareSigner } from "../src/index.ts";
import { rowsOf } from "./fixtures.ts";

const { signatures, versions, publish, delegate } = await loadIdentity(defaultValidator);

const signer = (scheme: Scheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const key = (scheme: Scheme, fill = 1) => signer(scheme, fill).key;
const knowing = (...signed: SignedIdentityObject[]) =>
  versions.known(
    rowsOf(versions, ...signed),
    new Map(signed.flatMap(({ blobs }) => blobs).map((bytes) => [linkOf(bytes), bytes])),
  );
const linksOf = (signed: readonly SignedIdentityObject[]) => signed.map(({ link }) => link);

const note: Schema<Json, { readonly text: string }> = await encodeSchema(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  defaultValidator,
);
const hello = encodeObject(note, { text: "hello" });

describe("a person", () => {
  const wallet = signer(eip191);

  it("is the root of the signed identity they are known by", async () => {
    const published = await publish(wallet);
    expect(knowing().of(published).root).toBe(published.identity.root);
  });

  it("has the versions of their root the reader knows and the one in hand, in order, each once", async () => {
    const first = await delegate(wallet, [key(ed25519, 2)], 1_000);
    const second = await delegate(wallet, [key(ed25519, 3)], 2_000);
    const third = await delegate(wallet, [key(ed25519, 4)], 3_000);
    const other = await delegate(signer(ed25519, 9), [key(ed25519, 2)], 1_500);
    const people = knowing(third, first, other);
    expect(linksOf(await people.of(second).versions())).toEqual(linksOf([first, second, third]));
    expect(linksOf(await people.of(first).versions())).toEqual(linksOf([first, third]));
  });

  it("has as current the latest version the reader knows, when known by their Identity too", async () => {
    const version = await delegate(wallet, [key(ed25519, 2)], 1_000);
    const person = knowing(version).of(await publish(wallet));
    expect(linksOf(await person.versions())).toEqual([version.link]);
    expect((await person.current()).link).toBe(version.link);
  });

  it("has as current the version in hand, when it is later than the reader knows", async () => {
    const earlier = await delegate(wallet, [key(ed25519, 2)], 1_000);
    const later = await delegate(wallet, [key(ed25519, 3)], 2_000);
    expect((await knowing(earlier).of(later).current()).link).toBe(later.link);
  });

  it("has as current their Identity in hand, and no versions, when the reader knows none", async () => {
    const published = await publish(wallet);
    const person = knowing(await delegate(signer(ed25519, 9), [key(ed25519, 2)], 1_000)).of(published);
    expect(await person.versions()).toEqual([]);
    expect((await person.current()).link).toBe(published.link);
  });

  it("signed a signature made for any identity of their root, and no other", async () => {
    const laptop = signer(ed25519, 2);
    const [published, version] = [await publish(wallet), await delegate(wallet, [laptop.key], 1_000)];
    const person = knowing().of(published);
    expect(person.signed(await signatures.actor(wallet, published).sign(hello))).toBe(true);
    expect(person.signed(await signatures.actor(laptop, version).sign(hello))).toBe(true);
    expect(person.signed(await signatures.actor(laptop, await publish(laptop)).sign(hello))).toBe(false);
  });
});
