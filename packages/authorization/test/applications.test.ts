import { identityFromJson, identityToJson, sameIdentity, SoftwareSigner, type Identity, type IdentityJson, type Scheme } from "@estoc/identity";
import { decodeObject, encodeObject, encodeSchema, linkOf, sign, type EncodedObject } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { describe, expect, it } from "vitest";
import { loadAuthorizations, type Signed } from "../src/index.ts";

// Applications that take signatures made through agents. Whether to accept
// agents, and how many, is each application's own rule; the package only
// reads who stands behind an object and through whom.

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const blobs = (...signed: Signed[]) => signed.flatMap(({ object, signature }) => [object.bytes, signature.bytes]);
const byLink = (received: readonly Uint8Array[]) => new Map<string, Uint8Array>(received.map((bytes) => [linkOf(bytes), bytes]));
const directly = async (object: EncodedObject, by: SoftwareSigner): Promise<Signed> => ({ object, signature: await sign(object, by) });

const authorizations = await loadAuthorizations(defaultValidator);

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
function loggedIn(audience: string, nonce: string, entry: Uint8Array, received: readonly Uint8Array[], now: Date): Identity {
  const expected = encodeObject(login, { audience, nonce });
  const { identity, agents } = authorizations.readStanding(expected.link, entry, byLink(received), now);
  if (agents.length > 1) throw new Error("this server accepts one agent at most");
  return identity;
}

describe("a login", () => {
  const wallet = signer("eip191", 1);
  const browserKey = signer("ed25519", 2);
  const object = encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" });
  const forADay = authorizations.authorize(browserKey.identity, wallet, "2026-10-21T12:00:00Z");
  const throughKey = forADay.then((grant) => authorizations.proxy(object.link, [grant], browserKey));
  const logIn = async (entry: Signed, at: Date) =>
    loggedIn("https://app.estoc.dev", "6f1c0a9e", entry.signature.bytes, blobs(await forADay, entry), at);

  it("through a key the wallet authorized for a day logs in the wallet", async () => {
    expect(await logIn(await throughKey, new Date("2026-10-20T12:00:00Z"))).toEqual(wallet.identity);
  });

  it("through that key logs no one in once the day is over", async () => {
    await expect(logIn(await throughKey, new Date("2026-10-21T12:00:00Z"))).rejects.toThrow(/ended at/);
  });

  it("signed by the key directly logs in the key, not the wallet", async () => {
    expect(await logIn(await directly(object, browserKey), new Date("2026-10-20T12:00:00Z"))).toEqual(browserKey.identity);
  });
});

type Sale = {
  readonly buyer: IdentityJson;
  readonly seller: IdentityJson;
  readonly goods: string;
  readonly price: string;
};

const sale = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Sale",
    type: "object",
    properties: {
      buyer: { $ref: "https://estoc.dev/schema/identity" },
      seller: { $ref: "https://estoc.dev/schema/identity" },
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
function saleInForce(bytes: Uint8Array, entries: readonly Uint8Array[], received: readonly Uint8Array[], now: Date): Sale | undefined {
  const terms = decodeObject(bytes, sale);
  const blobs = byLink(received);
  const standing = entries.flatMap((entry) => {
    try {
      return [authorizations.readStanding(terms.link, entry, blobs, now)];
    } catch {
      return [];
    }
  });
  const { buyer, seller } = terms.data as Sale;
  const behind = (party: IdentityJson) => standing.some(({ identity }) => sameIdentity(identity, identityFromJson(party)));
  return behind(buyer) && behind(seller) ? (terms.data as Sale) : undefined;
}

describe("a sale", () => {
  const buyer = signer("eip191", 1);
  const broker = signer("ed25519", 2);
  const seller = signer("solana-offchain", 3);
  const now = new Date("2026-10-20T12:00:00Z");
  const terms = encodeObject(sale, {
    buyer: identityToJson(buyer.identity),
    seller: identityToJson(seller.identity),
    goods: "one bicycle",
    price: "120.00 CAD",
  });
  const toBroker = authorizations.authorize(broker.identity, buyer);

  it("is in force once its seller signs it and its buyer signs it through a broker", async () => {
    const grant = await toBroker;
    const proxy = await authorizations.proxy(terms.link, [grant], broker);
    const entries = [(await directly(terms, seller)).signature.bytes, proxy.signature.bytes];
    expect(saleInForce(terms.bytes, entries, blobs(grant, proxy), now)).toEqual(terms.data);
  });

  it("is not in force when the broker signs it in its own name, as a witness would", async () => {
    const entries = [(await directly(terms, seller)).signature.bytes, (await directly(terms, broker)).signature.bytes];
    expect(saleInForce(terms.bytes, entries, blobs(await toBroker), now)).toBeUndefined();
  });
});
