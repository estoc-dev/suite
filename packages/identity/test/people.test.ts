import { encodeObject, encodeSchema, type Json, linkOf, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import {
  type CurveScheme,
  ed25519,
  eip191,
  loadIdentity,
  type SignedIdentityObject,
  SoftwareSigner,
} from "../src/index.ts";
import { rowsOf, schemes } from "./fixtures.ts";

const { signatures, identityVersions, publish, delegate } = await loadIdentity(defaultValidator, schemes);

const signer = (scheme: CurveScheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const key = (scheme: CurveScheme, fill = 1) => signer(scheme, fill).key;
const peopleHavingSeen = (...signed: SignedIdentityObject[]) =>
  identityVersions.people(
    rowsOf(identityVersions, ...signed),
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

  it("is the root of the signed identity they are taken from", async () => {
    const published = await publish(wallet, 1_000);
    expect(peopleHavingSeen().personOf(published).root).toBe(published.identity.root);
  });

  it("has the identity versions of their root the reader has seen and the one in hand, in order, each once", async () => {
    const first = await publish(wallet, 1_000);
    const second = await delegate(wallet, [key(ed25519, 2)], 2_000);
    const third = await delegate(wallet, [key(ed25519, 3)], 3_000);
    const other = await delegate(signer(ed25519, 9), [key(ed25519, 2)], 1_500);
    const people = peopleHavingSeen(third, first, other);
    expect(linksOf(await people.personOf(second).identityVersions())).toEqual(linksOf([first, second, third]));
    expect(linksOf(await people.personOf(first).identityVersions())).toEqual(linksOf([first, third]));
  });

  it("has as current the latest identity version the reader has seen, when the one in hand is earlier", async () => {
    const published = await publish(wallet, 1_000);
    const later = await delegate(wallet, [key(ed25519, 2)], 2_000);
    expect((await peopleHavingSeen(later).personOf(published).current()).link).toBe(later.link);
  });

  it("has as current the identity version in hand, when it is later than any the reader has seen", async () => {
    const earlier = await delegate(wallet, [key(ed25519, 2)], 1_000);
    const later = await publish(wallet, 2_000);
    expect((await peopleHavingSeen(earlier).personOf(later).current()).link).toBe(later.link);
  });

  it("has the identity version in hand alone, when the reader has seen none of their root", async () => {
    const published = await publish(wallet, 1_000);
    const person = peopleHavingSeen(await delegate(signer(ed25519, 9), [key(ed25519, 2)], 2_000)).personOf(published);
    expect(linksOf(await person.identityVersions())).toEqual([published.link]);
    expect((await person.current()).link).toBe(published.link);
  });

  it("signed a signature made for any identity of their root, and no other", async () => {
    const laptop = signer(ed25519, 2);
    const [published, identityVersion] = [await publish(wallet, 1_000), await delegate(wallet, [laptop.key], 2_000)];
    const person = peopleHavingSeen().personOf(published);
    expect(person.hasSigned(await signatures.actor(wallet, published).sign(hello))).toBe(true);
    expect(person.hasSigned(await signatures.actor(laptop, identityVersion).sign(hello))).toBe(true);
    expect(person.hasSigned(await signatures.actor(laptop, await publish(laptop, 1_000)).sign(hello))).toBe(false);
  });
});
