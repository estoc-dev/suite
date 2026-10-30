import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadSignatures, type Scheme, type Signer, SoftwareSigner } from "@estoc/identity";
import { encodeObject, encodeSchema, type Json, json, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { MemoryBackend, Store } from "@estoc/store";
import {
  type AccountOfferData,
  type AcknowledgementData,
  accountOfferSchema,
  acknowledgementSchema,
  type ServiceData,
  serviceSchema,
} from "../src/index.ts";
import { loadMailboxService, MemoryAccounts } from "../src/server.ts";

export const signer = (scheme: Scheme, fill: number) =>
  SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
export const memoryStore = () => new Store(json, new MemoryBackend());

export const signatures = await loadSignatures(defaultValidator);
export const { identities } = signatures;
export const actorOf = async (by: Signer) => signatures.actor(by, await identities.publish(by));
export const serviceSchemaRead: Schema<Json, ServiceData> = await encodeSchema(serviceSchema, defaultValidator);
export const offerSchema: Schema<Json, AccountOfferData> = await encodeSchema(accountOfferSchema, defaultValidator);
export const acknowledgementSchemaRead: Schema<Json, AcknowledgementData> = await encodeSchema(
  acknowledgementSchema,
  defaultValidator,
);

export const serviceSigner = signer("ed25519", 9);
export const serviceIdentity = identities.encode(serviceSigner.key);

/**
 * A service that keeps everything in memory, and whose clock counts up a
 * millisecond a reading from `start`. Given the store of another, it is
 * that service started again.
 */
export async function memoryService({
  start = 1_000,
  by = serviceSigner,
  origin = "https://mail.example",
  store = memoryStore(),
}: {
  readonly start?: number;
  readonly by?: Signer;
  readonly origin?: string;
  readonly store?: Store;
} = {}) {
  let now = start;
  const service = await loadMailboxService(by, {
    origin,
    store,
    accounts: new MemoryAccounts(),
    validator: defaultValidator,
    clock: () => now++,
  });
  return { service, store };
}

/**
 * The service's signatures over a Service like `service` at each of
 * `origins`, each with its Service, the greater link first.
 */
export async function signedAtOrigins(service: ServiceData, origins: readonly string[]) {
  const signed = await Promise.all(
    origins.map(async (origin) => {
      const object = encodeObject(serviceSchemaRead, { ...service, origin });
      return { object, signature: await (await actorOf(serviceSigner)).sign(object) };
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
