import { SoftwareSigner, type Scheme } from "@estoc/identity";
import {
  decodeObject,
  encodeObject,
  encodeSchema,
  linkOf,
  linkSchema,
  type IdentityObject,
  type Json,
  type JsonLink,
  type Link,
  type Schema,
  type Signature,
} from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { loadAuthorizations, type Entry } from "../src/index.ts";

// Applications that take signatures made through agents. Whether to accept
// agents, and how many, is each application's own rule; the package only
// reads who stands behind an object and through whom.

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const blobs = (...entries: Entry[]) => entries.flatMap(({ signature, blobs }) => [signature.bytes, ...blobs]);
const byLink = (received: readonly Uint8Array[]) => new Map<string, Uint8Array>(received.map((bytes) => [linkOf(bytes), bytes]));

const authorizations = await loadAuthorizations(defaultValidator);
const { identities } = authorizations.signatures;

const login = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Login",
    type: "object",
    properties: { audience: { type: "string", format: "uri" }, nonce: { type: "string" } },
    required: ["audience", "nonce"],
    additionalProperties: false,
  },
  defaultValidator,
);

// The server builds the login object from its audience and the nonce it
// handed out, and takes back one signature with the blobs it leads to. It
// accepts one agent at most: a key that the user's wallet authorized.
async function loggedIn(audience: string, nonce: string, entry: Link<Signature>, received: readonly Uint8Array[], now: Date): Promise<IdentityObject> {
  const expected = encodeObject(login, { audience, nonce });
  const { principal, agents } = await authorizations.readStanding(expected.link, entry, byLink(received), now);
  if (agents.length > 1) throw new Error("this server accepts one agent at most");
  return principal;
}

describe("a login", () => {
  const wallet = signer("eip191", 1);
  const browserKey = signer("ed25519", 2);
  const object = encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" });
  const forADay = authorizations.authorize(browserKey.identity, wallet, Temporal.Instant.from("2026-10-21T12:00:00Z"));
  const throughKey = forADay.then((grant) => authorizations.createActor(browserKey, [grant]).sign(object.link));
  const logIn = (entry: Entry, at: Date) => loggedIn("https://app.estoc.dev", "6f1c0a9e", entry.signature.link, blobs(entry), at);

  it("through a key the wallet authorized for a day logs in the wallet", async () => {
    expect(await logIn(await throughKey, new Date("2026-10-20T12:00:00Z"))).toEqual(identities.encode(wallet.identity));
  });

  it("through that key logs no one in once the day is over", async () => {
    await expect(logIn(await throughKey, new Date("2026-10-21T12:00:00Z"))).rejects.toThrow(/ended at/);
  });

  it("signed by the key directly logs in the key, not the wallet", async () => {
    const direct = await authorizations.createActor(browserKey).sign(object.link);
    expect(await logIn(direct, new Date("2026-10-20T12:00:00Z"))).toEqual(identities.encode(browserKey.identity));
  });
});

// A sale names its parties by the links of their identity objects.
type Sale = {
  readonly buyer: JsonLink<IdentityObject>;
  readonly seller: JsonLink<IdentityObject>;
  readonly goods: string;
  readonly price: string;
};

const sale: Schema<Json, Sale> = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Sale",
    type: "object",
    properties: {
      buyer: linkSchema,
      seller: linkSchema,
      goods: { type: "string" },
      price: { type: "string", pattern: "^[0-9]+\\.[0-9]{2} [A-Z]{3}$" },
    },
    required: ["buyer", "seller", "goods", "price"],
    additionalProperties: false,
  },
  defaultValidator,
);

// A sale is in force once its buyer and its seller both stand behind it, by
// their own signatures or through agents, as many as it takes. Each party
// hands in one signature, and one that does not read stands no one behind it.
async function saleInForce(bytes: Uint8Array, entries: readonly Link<Signature>[], received: readonly Uint8Array[], now: Date): Promise<Sale | undefined> {
  const terms = decodeObject(bytes, sale);
  const blobs = byLink(received);
  const standing = await Promise.all(entries.map((entry) => authorizations.readStanding(terms.link, entry, blobs, now).catch(() => undefined)));
  const { buyer, seller } = terms.data;
  const behind = (party: JsonLink<IdentityObject>) => standing.some((way) => way?.principal.link === party.$link);
  return behind(buyer) && behind(seller) ? terms.data : undefined;
}

describe("a sale", () => {
  const buyer = signer("eip191", 1);
  const broker = signer("ed25519", 2);
  const seller = signer("solana-offchain", 3);
  const now = new Date("2026-10-20T12:00:00Z");
  const terms = encodeObject(sale, {
    buyer: { $link: identities.encode(buyer.identity).link },
    seller: { $link: identities.encode(seller.identity).link },
    goods: "one bicycle",
    price: "120.00 CAD",
  });
  const toBroker = authorizations.authorize(broker.identity, buyer);
  const directly = (by: SoftwareSigner) => authorizations.createActor(by).sign(terms.link);
  const entriesOf = (...entries: Entry[]) => entries.map(({ signature }) => signature.link);

  it("is in force once its seller signs it and its buyer signs it through a broker", async () => {
    const proxy = await authorizations.createActor(broker, [await toBroker]).sign(terms.link);
    const bySeller = await directly(seller);
    expect(await saleInForce(terms.bytes, entriesOf(bySeller, proxy), blobs(bySeller, proxy), now)).toEqual(terms.data);
  });

  it("is not in force when the broker signs it in its own name, as a witness would", async () => {
    const [bySeller, byBroker] = await Promise.all([directly(seller), directly(broker)]);
    const { object, signature } = await toBroker;
    const received = [...blobs(bySeller, byBroker), object.bytes, signature.bytes];
    expect(await saleInForce(terms.bytes, entriesOf(bySeller, byBroker), received, now)).toBeUndefined();
  });
});
