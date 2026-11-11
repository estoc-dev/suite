import { encodeObject } from "@estoc/object";
import { schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  type CurveScheme,
  ed25519,
  eip191,
  loadIdentity,
  type SignedIdentityObject,
  SoftwareSigner,
} from "../src/index.ts";
import { rowsOf, schemes, storeOf } from "./fixtures.ts";

const { signatures, identityVersions, publish } = await loadIdentity(schemes);

const signer = (scheme: CurveScheme, fill = 1) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const key = (scheme: CurveScheme, fill = 1) => signer(scheme, fill).key;
const peopleHavingSeen = (...signed: SignedIdentityObject[]) =>
  identityVersions.people(rowsOf(identityVersions, ...signed), storeOf(signed.flatMap(({ blobs }) => blobs)));
const linksOf = (signed: readonly SignedIdentityObject[]) => signed.map(({ link }) => link);

const note = await schema("Note", { text: string() });
const hello = encodeObject(note, { text: "hello" });

describe("a person", () => {
  const wallet = signer(eip191);

  it("is named by the identifier of the signed identity they are taken from", async () => {
    const published = await publish(wallet, { at: 1_000 });
    expect(peopleHavingSeen().personOf(published).identifier).toBe(published.identity.identifier);
  });

  it("has the identity versions of their root the reader has seen and the one in hand with those it follows, in order, each once", async () => {
    const first = await publish(wallet, { at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [key(ed25519, 2)], at: 2_000 });
    const third = await publish(wallet, { prior: second, agents: [key(ed25519, 3)], at: 3_000 });
    const branch = await publish(wallet, { prior: first, agents: [key(ed25519, 4)], at: 2_500 });
    const other = await publish(signer(ed25519, 9), { agents: [key(ed25519, 2)], at: 1_500 });
    const people = peopleHavingSeen(branch, first, other);
    expect(linksOf(await people.personOf(third).identityVersions())).toEqual(linksOf([first, second, branch, third]));
    expect(linksOf(await people.personOf(first).identityVersions())).toEqual(linksOf([first, branch]));
  });

  it("has as current the latest identity version the reader has seen, when the one in hand is earlier", async () => {
    const published = await publish(wallet, { at: 1_000 });
    const later = await publish(wallet, { prior: published, agents: [key(ed25519, 2)], at: 2_000 });
    expect((await peopleHavingSeen(later).personOf(published).current()).link).toBe(later.link);
  });

  it("has as current the identity version in hand, when it is later than any the reader has seen", async () => {
    const earlier = await publish(wallet, { agents: [key(ed25519, 2)], at: 1_000 });
    const later = await publish(wallet, { prior: earlier, at: 2_000 });
    expect((await peopleHavingSeen(earlier).personOf(later).current()).link).toBe(later.link);
  });

  it("has the identity version in hand alone, when the reader has seen none of their root", async () => {
    const published = await publish(wallet, { at: 1_000 });
    const person = peopleHavingSeen(
      await publish(signer(ed25519, 9), { agents: [key(ed25519, 2)], at: 2_000 }),
    ).personOf(published);
    expect(linksOf(await person.identityVersions())).toEqual([published.link]);
    expect((await person.current()).link).toBe(published.link);
  });

  it("has as identity versions the latest crisis and those that follow it, once the reader has seen one that follows it", async () => {
    const first = await publish(wallet, { at: 1_000 });
    const second = await publish(wallet, { prior: first, agents: [key(ed25519, 2)], at: 2_000 });
    const crisis = await publish(wallet, { prior: second, isCrisis: true, at: 3_000 });
    const after = await publish(wallet, { prior: crisis, agents: [key(ed25519, 3)], at: 4_000 });
    const person = peopleHavingSeen(after).personOf(second);
    expect(linksOf(await person.identityVersions())).toEqual(linksOf([crisis, after]));
    expect((await person.current()).link).toBe(after.link);
  });

  it("has as current the latest crisis over a later identity version on a branch it cuts", async () => {
    const first = await publish(wallet, { at: 1_000 });
    const crisis = await publish(wallet, { prior: first, isCrisis: true, at: 2_000 });
    const branch = await publish(wallet, { prior: first, agents: [key(ed25519, 2)], at: 3_000 });
    const person = peopleHavingSeen(crisis).personOf(branch);
    expect(linksOf(await person.identityVersions())).toEqual([crisis.link]);
    expect((await person.current()).link).toBe(crisis.link);
  });

  it("signed a signature made for any of their identities, and no other", async () => {
    const laptop = signer(ed25519, 2);
    const published = await publish(wallet, { at: 1_000 });
    const identityVersion = await publish(wallet, { prior: published, agents: [laptop.key], at: 2_000 });
    const person = peopleHavingSeen().personOf(published);
    expect(person.hasSigned(await signatures.actor(wallet, published).sign(hello))).toBe(true);
    expect(person.hasSigned(await signatures.actor(laptop, identityVersion).sign(hello))).toBe(true);
    expect(person.hasSigned(await signatures.actor(laptop, await publish(laptop, { at: 1_000 })).sign(hello))).toBe(
      false,
    );
  });
});
