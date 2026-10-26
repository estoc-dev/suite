import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadAuthorizations } from "@estoc/authorization";
import { type Scheme, SoftwareSigner } from "@estoc/identity";
import { encodeSchema, type Json, json, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { MemoryBackend, Store } from "@estoc/store";
import {
  type AccountOfferData,
  type AcknowledgementData,
  accountOfferSchema,
  acknowledgementSchema,
} from "../src/index.ts";
import { loadMailboxService, MemoryAccounts } from "../src/server.ts";

export const signer = (scheme: Scheme, fill: number) =>
  SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
export const memoryStore = () => new Store(json, new MemoryBackend());

export const authorizations = await loadAuthorizations(defaultValidator);
export const { signatures } = authorizations;
export const { identities } = signatures;
export const offerSchema: Schema<Json, AccountOfferData> = await encodeSchema(
  accountOfferSchema,
  defaultValidator,
);
export const acknowledgementSchemaRead: Schema<Json, AcknowledgementData> = await encodeSchema(
  acknowledgementSchema,
  defaultValidator,
);

export const serviceSigner = signer("ed25519", 9);
export const serviceIdentity = identities.encode(serviceSigner.identity);

/** A service that keeps everything in memory, and whose clock counts up a millisecond a reading from `start`. */
export async function memoryService({
  start = 1_000,
  by = serviceSigner,
}: {
  readonly start?: number;
  readonly by?: SoftwareSigner;
} = {}) {
  let now = start;
  const store = memoryStore();
  const service = await loadMailboxService(by, {
    store,
    accounts: new MemoryAccounts(),
    validator: defaultValidator,
    clock: () => now++,
  });
  return { service, store };
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
    const response = await handle(
      new Request(new URL(incoming.url ?? "/", origin), { method, body }),
    );
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
