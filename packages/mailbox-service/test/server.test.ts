import { readObject, type Link } from "@estoc/object";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { unzipped, zipped } from "../src/http.ts";
import type { MailboxService } from "../src/server.ts";
import {
  acknowledgementSchemaRead,
  authorizations,
  identities,
  memoryService,
  offerSchema,
  serviceIdentity,
  signatures,
  signer,
} from "./fixtures.ts";

const alice = signer("ed25519", 1);
const wallet = signer("eip191", 2);
const device = signer("ed25519", 3);
const otherService = signer("ed25519", 4);

const getOffer = (service: MailboxService) => service.fetch(new Request("https://mail.example/offer"));
const post = (service: MailboxService, body: Uint8Array) => service.fetch(new Request("https://mail.example/", { method: "POST", body }));
const bundleOf = async (response: Response) => unzipped(new Uint8Array(await response.arrayBuffer()));

async function offerOf(service: MailboxService) {
  const bundle = await bundleOf(await getOffer(service));
  const signature = await signatures.read(bundle.link, bundle);
  return { bundle, signature, offer: await readObject(bundle, signature.object, offerSchema) };
}

/** The bundle that accepts `offer` by `by`'s own signature, with its identity. */
async function direct(offer: { readonly link: Link<unknown> }, by = alice) {
  const signature = await signatures.sign(offer, by);
  return { signature, zip: await zipped(signature, [signature.identity.bytes]) };
}

/** The bundle that accepts `offer` for the wallet, through a proxy that the device signs. */
async function proxied(offer: { readonly link: Link<unknown> }, until?: Temporal.Instant) {
  const grant = await authorizations.authorize(device.identity, wallet, until);
  const { signature, blobs } = await authorizations.createActor(device, [grant]).sign(offer.link);
  return { signature, zip: await zipped(signature, blobs) };
}

async function acknowledgementIn(response: Response) {
  const bundle = await bundleOf(response);
  const signature = await signatures.read(bundle.link, bundle);
  return { bundle, signature, acknowledgement: await readObject(bundle, signature.object, acknowledgementSchemaRead) };
}

describe("a mailbox service", () => {
  it("answers GET /offer with its signature over an offer that names its identity", async () => {
    const { service } = await memoryService();
    const response = await getOffer(service);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const { signature, offer } = await offerOf(service);
    expect(signature.identity.link).toBe(serviceIdentity.link);
    expect(offer.data).toEqual({ identity: { $link: serviceIdentity.link } });
  });

  it("opens an account for the identity that signs its offer, and answers 201 with its signature over an acknowledgement", async () => {
    const { service } = await memoryService({ start: 5_000 });
    const { offer } = await offerOf(service);
    const accepted = await direct(offer);
    const response = await post(service, accepted.zip);
    expect(response.status).toBe(201);
    const { bundle, signature, acknowledgement } = await acknowledgementIn(response);
    expect(signature.identity.link).toBe(serviceIdentity.link);
    expect(acknowledgement.data).toEqual({ accepted: { $link: accepted.signature.link }, at: 5_000 });
    expect(await authorizations.readStanding(offer.link, accepted.signature.link, bundle, new Date(5_000))).toEqual({
      principal: identities.encode(alice.identity),
      agents: [],
    });
  });

  it("answers 200 with the same acknowledgement when the same acceptance comes again", async () => {
    const { service } = await memoryService();
    const { zip } = await direct((await offerOf(service)).offer);
    const first = new Uint8Array(await (await post(service, zip)).arrayBuffer());
    const again = await post(service, zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
  });

  it("opens the account of the principal for an agent's signature over a proxy", async () => {
    const { service } = await memoryService();
    const { offer } = await offerOf(service);
    const accepted = await proxied(offer);
    const response = await post(service, accepted.zip);
    expect(response.status).toBe(201);
    const { bundle, acknowledgement } = await acknowledgementIn(response);
    const { accepted: link, at } = acknowledgement.data;
    expect(link.$link).toBe(accepted.signature.link);
    expect(await authorizations.readStanding(offer.link, link.$link, bundle, new Date(at))).toEqual({
      principal: identities.encode(wallet.identity),
      agents: [identities.encode(device.identity)],
    });
  });

  it("answers an identity that accepts again, another way, with the acknowledgement of its first acceptance", async () => {
    const { service } = await memoryService();
    const { offer } = await offerOf(service);
    const first = new Uint8Array(await (await post(service, (await direct(offer, wallet)).zip)).arrayBuffer());
    const again = await post(service, (await proxied(offer)).zip);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(first);
  });

  it.each<[string, (service: MailboxService) => Promise<Uint8Array>]>([
    ["that is not a zip", async () => new TextEncoder().encode("hello")],
    ["whose root is not a signature", async (service) => zipped((await offerOf(service)).offer, [])],
    ["whose signature comes without its identity", async (service) => zipped((await direct((await offerOf(service)).offer)).signature, [])],
    [
      "accepting another service's offer",
      async () => {
        const { service: other } = await memoryService({ by: otherService });
        return (await direct((await offerOf(other)).offer)).zip;
      },
    ],
    ["through an authorization that has ended", async (service) => (await proxied((await offerOf(service)).offer, Temporal.Instant.fromEpochMilliseconds(500))).zip],
    ["that is the service's own signature over its offer", async (service) => new Uint8Array(await (await getOffer(service)).arrayBuffer())],
  ])("answers 400 to a bundle %s, and opens no account", async (_, body) => {
    const { service, store } = await memoryService();
    const response = await post(service, await body(service));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toBe("");
    const mine = [];
    for await (const link of store.mine()) mine.push(link);
    expect(mine).toEqual([(await offerOf(service)).signature.link]);
  });

  it("answers 413 to a body of more than 64 KiB", async () => {
    const { service } = await memoryService();
    expect((await post(service, new Uint8Array(64 * 1024 + 1))).status).toBe(413);
  });

  it("answers 405 to another method, saying which it takes, and 404 to another path", async () => {
    const { service } = await memoryService();
    const put = await service.fetch(new Request("https://mail.example/offer", { method: "PUT", body: "x" }));
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET");
    expect((await service.fetch(new Request("https://mail.example/"))).headers.get("allow")).toBe("POST");
    expect((await service.fetch(new Request("https://mail.example/accounts"))).status).toBe(404);
  });

  it("answers a browser's preflight for posting a zip from another origin", async () => {
    const { service } = await memoryService();
    const response = await service.fetch(new Request("https://mail.example/", { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
    });
  });
});
