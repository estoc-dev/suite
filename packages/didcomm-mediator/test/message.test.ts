import { describe, expect, it, test } from "vitest";
import {
  anoncrypt,
  authcrypt,
  type Message,
  multibaseOf,
  OfflineResolver,
  packEncrypted,
  peerDid2,
  peerDid4,
  SecretKey,
  type Secrets,
  sign,
  unpack,
} from "../src/envelope/index.ts";

const encoder = new TextEncoder();

/** A party with a did:peer:2 of an Ed25519 key, #key-1, and an X25519 key, #key-2. */
function party() {
  const signing = SecretKey.random("Ed25519");
  const agreement = SecretKey.random("X25519");
  const did = peerDid2({
    keys: [
      { purpose: "authentication", key: signing.publicKey },
      { purpose: "keyAgreement", key: agreement.publicKey },
    ],
  });
  const secrets: Secrets = (kid) => (kid === `${did}#key-1` ? signing : kid === `${did}#key-2` ? agreement : undefined);
  return { did, signing, agreement, secrets, signer: `${did}#key-1`, agreer: `${did}#key-2` };
}

const alice = party();
const bob = party();
const mallory = party();
const resolver = new OfflineResolver();

const messageFrom = (from: string | undefined, to: string[] = [bob.did]): Message => ({
  id: "1",
  type: "https://example.com/protocols/test/1.0/hello",
  ...(from === undefined ? {} : { from }),
  to,
  body: { text: "hello" },
});

const unpackByBob = (packed: string) => unpack(packed, { resolver, secrets: bob.secrets });

describe("a message packed to bob", () => {
  it("anoncrypted says nothing of who sent it", async () => {
    const message = messageFrom(undefined);
    const packed = await packEncrypted(message, { to: bob.did, resolver, secrets: () => undefined });
    expect(await unpackByBob(packed)).toEqual({
      message,
      envelopes: [{ kind: "anoncrypt", recipient: bob.agreer, enc: "A256CBC-HS512" }],
      sender: undefined,
    });
  });

  it("authcrypted is from alice", async () => {
    const message = messageFrom(alice.did);
    const packed = await packEncrypted(message, { to: bob.did, from: alice.did, resolver, secrets: alice.secrets });
    expect(await unpackByBob(packed)).toEqual({
      message,
      envelopes: [{ kind: "authcrypt", recipient: bob.agreer, sender: alice.agreer }],
      sender: alice.did,
    });
  });

  it("authcrypted and anoncrypted again hides alice from all but bob", async () => {
    const packed = await packEncrypted(messageFrom(alice.did), {
      to: bob.did,
      from: alice.did,
      protectSender: true,
      enc: "XC20P",
      resolver,
      secrets: alice.secrets,
    });
    expect(packed).not.toContain(alice.did);
    const unpacked = await unpackByBob(packed);
    expect(unpacked.envelopes.map((envelope) => envelope.kind)).toEqual(["anoncrypt", "authcrypt"]);
    expect(unpacked.sender).toBe(alice.did);
  });

  it("signed and anoncrypted is from alice, and keeps the signature", async () => {
    const message = messageFrom(alice.did);
    const packed = await packEncrypted(message, { to: bob.did, signBy: alice.did, resolver, secrets: alice.secrets });
    const unpacked = await unpackByBob(packed);
    expect(unpacked.message).toEqual(message);
    expect(unpacked.sender).toBe(alice.did);
    const [outer, signed] = unpacked.envelopes;
    expect(outer?.kind).toBe("anoncrypt");
    expect(signed).toMatchObject({ kind: "signed", signer: alice.signer });
    // The signature still verifies for anyone who is shown it.
    const shown = signed?.kind === "signed" ? signed.jws : "";
    expect((await unpack(shown, { resolver, secrets: () => undefined })).sender).toBe(alice.did);
  });

  it("is not opened by another", async () => {
    const packed = await packEncrypted(messageFrom(alice.did), {
      to: bob.did,
      from: alice.did,
      resolver,
      secrets: alice.secrets,
    });
    await expect(unpack(packed, { resolver, secrets: mallory.secrets })).rejects.toThrow(/no key held here/);
  });
});

describe("packing refuses", () => {
  test("a from that is not the sender's", async () => {
    await expect(
      packEncrypted(messageFrom(mallory.did), { to: bob.did, from: alice.did, resolver, secrets: alice.secrets }),
    ).rejects.toThrow(/from is not/);
  });

  test("a signed message that does not name bob in to", async () => {
    await expect(
      packEncrypted(messageFrom(alice.did, []), { to: bob.did, signBy: alice.did, resolver, secrets: alice.secrets }),
    ).rejects.toThrow(/names .* in its to/);
  });

  test("authcrypt of a signed message", async () => {
    await expect(
      packEncrypted(messageFrom(alice.did), {
        to: bob.did,
        from: alice.did,
        signBy: alice.did,
        resolver,
        secrets: alice.secrets,
      }),
    ).rejects.toThrow(/not both/);
  });

  test("a sender whose keys are not held", async () => {
    await expect(
      packEncrypted(messageFrom(alice.did), { to: bob.did, from: alice.did, resolver, secrets: () => undefined }),
    ).rejects.toThrow(/is held here/);
  });
});

describe("unpacking refuses", () => {
  const bobKeys = [{ kid: bob.agreer, key: bob.agreement.publicKey }];
  const bytes = (value: unknown) => encoder.encode(JSON.stringify(value));

  test("an authcrypted message whose from is not the sender's DID", async () => {
    const jwe = authcrypt(bytes(messageFrom(mallory.did)), { kid: alice.agreer, secret: alice.agreement }, bobKeys);
    await expect(unpackByBob(JSON.stringify(jwe))).rejects.toThrow(/from is not the DID of/);
  });

  test("a signed message whose from is not the signer's DID", async () => {
    const jws = sign(bytes(messageFrom(alice.did)), { kid: mallory.signer, secret: mallory.signing });
    await expect(unpackByBob(JSON.stringify(anoncrypt(bytes(jws), bobKeys)))).rejects.toThrow(/from is not the DID of/);
  });

  test("authcrypt of a message signed by another", async () => {
    const jws = sign(bytes(messageFrom(mallory.did)), { kid: mallory.signer, secret: mallory.signing });
    const jwe = authcrypt(bytes(jws), { kid: alice.agreer, secret: alice.agreement }, bobKeys);
    await expect(unpackByBob(JSON.stringify(jwe))).rejects.toThrow(/from is not the DID of/);
  });

  test("a signed message that is encrypted, but has no to", async () => {
    const { to: _, ...noTo } = messageFrom(alice.did);
    const jws = sign(bytes(noTo), { kid: alice.signer, secret: alice.signing });
    await expect(unpackByBob(JSON.stringify(anoncrypt(bytes(jws), bobKeys)))).rejects.toThrow(/has no to/);
  });

  test("an authenticated message whose to does not name bob", async () => {
    const jwe = authcrypt(
      bytes(messageFrom(alice.did, [mallory.did])),
      { kid: alice.agreer, secret: alice.agreement },
      bobKeys,
    );
    await expect(unpackByBob(JSON.stringify(jwe))).rejects.toThrow(/to does not name/);
  });

  test("envelopes in another order, or twice", async () => {
    const inner = anoncrypt(bytes(messageFrom(undefined)), bobKeys);
    const signedJwe = sign(bytes(inner), { kid: alice.signer, secret: alice.signing });
    await expect(unpackByBob(JSON.stringify(signedJwe))).rejects.toThrow(/anoncrypt message inside a signed/);
    const twice = anoncrypt(bytes(inner), bobKeys);
    await expect(unpackByBob(JSON.stringify(twice))).rejects.toThrow(/anoncrypt message inside a anoncrypt/);
  });

  test("what is not a message", async () => {
    await expect(unpackByBob(JSON.stringify(anoncrypt(bytes({ type: "x" }), bobKeys)))).rejects.toThrow(/no id/);
    await expect(unpackByBob("[]")).rejects.toThrow(/not a JSON object/);
  });
});

test("an anoncrypted message's from proves nothing, and is not checked", async () => {
  const bobKeys = [{ kid: bob.agreer, key: bob.agreement.publicKey }];
  const jwe = anoncrypt(encoder.encode(JSON.stringify(messageFrom(alice.did, [mallory.did]))), bobKeys);
  const unpacked = await unpackByBob(JSON.stringify(jwe));
  expect(unpacked.sender).toBeUndefined();
  expect(unpacked.message.from).toBe(alice.did);
});

test("a did:peer:4 sender is one DID in its long and short forms, named by the short", async () => {
  const agreement = SecretKey.random("X25519");
  const long = peerDid4({
    verificationMethod: [{ id: "#key-1", type: "Multikey", publicKeyMultibase: multibaseOf(agreement.publicKey) }],
    keyAgreement: ["#key-1"],
  });
  const short = long.slice(0, long.lastIndexOf(":"));
  const bobsResolver = new OfflineResolver();
  // Bob has seen the long form, as in an invitation, before the short form is used.
  await bobsResolver.resolve(long);
  const jwe = authcrypt(
    encoder.encode(JSON.stringify(messageFrom(long))),
    { kid: `${short}#key-1`, secret: agreement },
    [{ kid: bob.agreer, key: bob.agreement.publicKey }],
  );
  const unpacked = await unpack(JSON.stringify(jwe), { resolver: bobsResolver, secrets: bob.secrets });
  expect(unpacked.sender).toBe(short);
});
