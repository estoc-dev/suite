import { decodeObject, type EncodedObject, encodeObject, type Link, LinkValue, type Reader } from "@estoc/object";
import { type DataOf, link, schema, string } from "@estoc/schema";
import { describe, expect, it } from "vitest";
import {
  type CurveScheme,
  ed25519,
  eip191,
  type IdentityObject,
  type KeyObject,
  loadIdentity,
  noIdentityVersions,
  type Signature,
  type Signer,
  SoftwareSigner,
  solanaOffchain,
} from "../src/index.ts";
import { byLink, schemes } from "./fixtures.ts";

// Applications built on objects and signatures. What makes a login or a sale
// hold is each application's own rule, written here against the schemas it
// pins; the package only reads the blobs.

const { keys, identities, signatures, publish } = loadIdentity(schemes);

const signer = (scheme: CurveScheme, fill: number) =>
  SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const sign = async (object: { readonly link: Link<unknown> }, by: Signer) =>
  signatures.actor(by, await publish(by, { at: 0 })).sign(object);

/**
 * What an application holds: blobs by link, the objects of the identities
 * that signed among them, and the signatures it was given.
 */
interface ReceivedSignatures {
  readonly blobs: Reader;
  readonly signatures: readonly Uint8Array[];
}

async function signersOf(link: Link<unknown>, receivedSignatures: ReceivedSignatures): Promise<IdentityObject[]> {
  const read = receivedSignatures.signatures.map((bytes) =>
    signatures.verify(decodeObject(bytes, signatures.schema), receivedSignatures.blobs, noIdentityVersions),
  );
  return (await Promise.all(read))
    .filter((signature) => signature.object === link)
    .map((signature) => signature.signedIdentity.identity);
}

const login = schema("Login", { audience: string(), nonce: string() });

// The server knows its audience and the nonce it handed out, so it builds the
// object itself and needs back only the signature, with the blobs of the
// identity that signed.
async function loggedInIdentity(
  audience: string,
  nonce: string,
  signature: Uint8Array,
  identity: readonly Uint8Array[],
): Promise<IdentityObject | undefined> {
  const expected = encodeObject(login, { audience, nonce });
  const read = await signatures.verify(
    decodeObject(signature, signatures.schema),
    byLink(identity),
    noIdentityVersions,
  );
  return read.object === expected.link ? read.signedIdentity.identity : undefined;
}

describe("a login", () => {
  const user = signer(eip191, 1);
  const signed = sign(encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" }), user);
  const logIn = async (audience: string, nonce: string) => {
    const { bytes, signedIdentity } = await signed;
    return loggedInIdentity(audience, nonce, bytes, signedIdentity.blobs);
  };

  it("logs in whoever signed it, though the object names no one", async () => {
    expect(await logIn("https://app.estoc.dev", "6f1c0a9e")).toEqual(identities.encode(user.key, { at: 0 }));
  });

  it("for another nonce or audience logs no one in", async () => {
    expect(await logIn("https://app.estoc.dev", "0b5e7d21")).toBeUndefined();
    expect(await logIn("https://other.example", "6f1c0a9e")).toBeUndefined();
  });

  it("signed by a browser key that a later identity version of the user lists logs the user in", async () => {
    const browser = signer(ed25519, 5);
    const prior = (await signed).signedIdentity;
    const actor = signatures.actor(browser, await publish(user, { prior, agents: [browser.key], at: 1 }));
    const { bytes, signedIdentity } = await actor.sign(
      encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" }),
    );
    const identity = await loggedInIdentity("https://app.estoc.dev", "6f1c0a9e", bytes, signedIdentity.blobs);
    expect(identity?.link).not.toBe(identities.encode(user.key, { at: 0 }).link);
    expect(identity?.identifier).toBe((await logIn("https://app.estoc.dev", "6f1c0a9e"))?.identifier);
  });
});

// A sale names its parties by their identifiers, and a signature its signer
// by a signed identity whose closure holds one.
const sale = schema("Sale", {
  buyer: link<KeyObject>(),
  seller: link<KeyObject>(),
  goods: string(),
  price: string(),
});
type Sale = DataOf<typeof sale>;

const delivery = schema("Delivery", { sale: link<EncodedObject<Sale>>() });

// A sale is in force once its buyer and its seller have both signed it.
async function saleInForce(
  link: Link<EncodedObject<Sale>>,
  receivedSignatures: ReceivedSignatures,
): Promise<Sale | undefined> {
  const bytes = await receivedSignatures.blobs.get(link);
  if (bytes === undefined) return undefined;
  const terms = decodeObject(bytes, sale).data;
  const signers = await signersOf(link, receivedSignatures);
  const signed = (party: LinkValue<KeyObject>) => signers.some((identity) => identity.identifier === party.link);
  return signed(terms.buyer) && signed(terms.seller) ? terms : undefined;
}

// A delivery is confirmed once the buyer of a sale in force signs for it.
async function isDeliveryConfirmed(link: Link<unknown>, receivedSignatures: ReceivedSignatures): Promise<boolean> {
  const bytes = await receivedSignatures.blobs.get(link);
  if (bytes === undefined) return false;
  const terms = await saleInForce(decodeObject(bytes, delivery).data.sale.link, receivedSignatures);
  return (
    terms !== undefined &&
    (await signersOf(link, receivedSignatures)).some((identity) => identity.identifier === terms.buyer.link)
  );
}

const buyer = signer(eip191, 1);
const seller = signer(ed25519, 2);
const witness = signer(solanaOffchain, 3);
const terms = encodeObject(sale, {
  buyer: new LinkValue(keys.encode(buyer.key).link),
  seller: new LinkValue(keys.encode(seller.key).link),
  goods: "one bicycle",
  price: "120.00 CAD",
});
const confirmation = encodeObject(delivery, { sale: new LinkValue(terms.link) });
const receive = (signed: readonly Signature[]): ReceivedSignatures => ({
  blobs: byLink([terms.bytes, confirmation.bytes, ...signed.flatMap(({ signedIdentity }) => signedIdentity.blobs)]),
  signatures: signed.map(({ bytes }) => bytes),
});
const signedBy = (...pairs: [{ readonly link: Link<unknown> }, SoftwareSigner][]) =>
  Promise.all(pairs.map(([object, by]) => sign(object, by)));

describe("a sale", () => {
  it("is in force only once its buyer and its seller have both signed it", async () => {
    expect(await saleInForce(terms.link, receive(await signedBy([terms, buyer])))).toBeUndefined();
    const both = await signedBy([terms, buyer], [terms, seller]);
    expect(await saleInForce(terms.link, receive(both))).toEqual(terms.data);
  });

  it("takes a signature from someone it does not name, without counting it as a party's", async () => {
    const witnessed = await sign(terms, witness);
    const receivedSignatures = receive([...(await signedBy([terms, buyer])), witnessed]);
    expect(await signersOf(terms.link, receivedSignatures)).toContainEqual(identities.encode(witness.key, { at: 0 }));
    expect(await saleInForce(terms.link, receivedSignatures)).toBeUndefined();
  });
});

describe("a delivery", () => {
  it("is confirmed when the buyer of a sale in force signs for it", async () => {
    const receivedSignatures = receive(await signedBy([terms, buyer], [terms, seller], [confirmation, buyer]));
    expect(await isDeliveryConfirmed(confirmation.link, receivedSignatures)).toBe(true);
  });

  it("is not confirmed when only the seller signs for it", async () => {
    const receivedSignatures = receive(await signedBy([terms, buyer], [terms, seller], [confirmation, seller]));
    expect(await isDeliveryConfirmed(confirmation.link, receivedSignatures)).toBe(false);
  });

  it("is not confirmed while the sale is not in force", async () => {
    const receivedSignatures = receive(await signedBy([terms, buyer], [confirmation, buyer]));
    expect(await isDeliveryConfirmed(confirmation.link, receivedSignatures)).toBe(false);
  });
});
