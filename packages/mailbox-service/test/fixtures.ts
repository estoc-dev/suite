import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ed25519, loadIdentity, type Scheme, type Signer, SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, type Json, json, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { MemoryBackend, Store } from "@estoc/store";
import {
  type AccountOfferData,
  type AcknowledgementData,
  accountOfferSchema,
  acknowledgementSchema,
  type MailboxAcknowledgementData,
  type MailboxOfferData,
  type MailboxRequestData,
  type MailboxTerms,
  mailboxAcknowledgementSchema,
  mailboxOfferSchema,
  mailboxRequestSchema,
  type PickupRequestData,
  pickupRequestSchema,
  type ServiceData,
  serviceSchema,
  type WaitingData,
  waitingSchema,
} from "../src/index.ts";
import { type Accounts, loadMailboxService, type Mailboxes, MemoryAccounts, MemoryMailboxes } from "../src/server.ts";

export const signer = (scheme: Scheme, fill: number) =>
  SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
export const memoryStore = () => new Store(json, new MemoryBackend());

export const { keys, identities, signedIdentities, signatures, publish, delegate } =
  await loadIdentity(defaultValidator);
export const actorOf = async (by: Signer) => signatures.actor(by, await publish(by, 0));
export const serviceSchemaRead: Schema<Json, ServiceData> = await encodeSchema(serviceSchema, defaultValidator);
export const offerSchema: Schema<Json, AccountOfferData> = await encodeSchema(accountOfferSchema, defaultValidator);
export const acknowledgementSchemaRead: Schema<Json, AcknowledgementData> = await encodeSchema(
  acknowledgementSchema,
  defaultValidator,
);
export const mailboxOfferSchemaRead: Schema<Json, MailboxOfferData> = await encodeSchema(
  mailboxOfferSchema,
  defaultValidator,
);
export const mailboxRequestSchemaRead: Schema<Json, MailboxRequestData> = await encodeSchema(
  mailboxRequestSchema,
  defaultValidator,
);
export const mailboxAcknowledgementSchemaRead: Schema<Json, MailboxAcknowledgementData> = await encodeSchema(
  mailboxAcknowledgementSchema,
  defaultValidator,
);
export const pickupRequestSchemaRead: Schema<Json, PickupRequestData> = await encodeSchema(
  pickupRequestSchema,
  defaultValidator,
);
export const waitingSchemaRead: Schema<Json, WaitingData> = await encodeSchema(waitingSchema, defaultValidator);

export const terms: MailboxTerms = { retention: 60_000, quota: 4096, size: 1024 };

export const serviceSigner = signer(ed25519, 9);
export const serviceRoot = keys.encode(serviceSigner.key);
/** The Identity a service by `serviceSigner` signs when it first starts, at `start`. */
export const serviceIdentity = (start: number) => identities.encode(serviceSigner.key, start);
/** An actor for that Identity, which signs as the service does. */
export const serviceActor = async (start: number) =>
  signatures.actor(serviceSigner, await signedIdentities.sign(serviceSigner, serviceIdentity(start)));

/**
 * A service that keeps everything in memory, and whose clock counts up a
 * millisecond a reading from `start`, or stands at `clock.now` when it is
 * given, which a test moves. Given the store of another, with its accounts
 * and its mailboxes, it is that service started again.
 */
export async function memoryService({
  start = 1_000,
  by = serviceSigner,
  origin = "https://mail.example",
  store = memoryStore(),
  offered = terms,
  clock,
  accounts = new MemoryAccounts(),
  mailboxes = new MemoryMailboxes(),
}: {
  readonly start?: number;
  readonly by?: Signer;
  readonly origin?: string;
  readonly store?: Store;
  readonly offered?: MailboxTerms;
  readonly clock?: { now: number };
  readonly accounts?: Accounts;
  readonly mailboxes?: Mailboxes;
} = {}) {
  let now = start;
  const service = await loadMailboxService(by, {
    origin,
    store,
    accounts,
    mailboxes,
    terms: offered,
    validator: defaultValidator,
    clock: clock === undefined ? () => now++ : () => clock.now,
  });
  return { service, store, accounts, mailboxes };
}

/**
 * The signatures over a Service like `service` at each of `origins`, each
 * with its Service, the greater link first, of a service that first started
 * at 1000, as `memoryService` starts one unless it is given another start.
 */
export async function signedAtOrigins(service: ServiceData, origins: readonly string[]) {
  const actor = await serviceActor(1_000);
  const signed = await Promise.all(
    origins.map(async (origin) => {
      const object = encodeObject(serviceSchemaRead, { ...service, origin });
      return { object, signature: await actor.sign(object) };
    }),
  );
  return signed.sort((a, b) => (a.signature.link < b.signature.link ? 1 : -1));
}

/** Serves `handle` over HTTP at 127.0.0.1, as a host would run a service's handler. */
export async function serve(
  handle: (request: Request) => Promise<Response>,
): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const method = incoming.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? null : Buffer.concat(chunks);
    const response = await handle(new Request(new URL(incoming.url ?? "/", origin), { method, body }));
    outgoing
      .writeHead(response.status, Object.fromEntries(response.headers))
      .end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { origin, close };
}
