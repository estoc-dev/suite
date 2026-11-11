import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CurveScheme,
  ed25519,
  eip191,
  loadIdentity,
  type Signer,
  SoftwareSigner,
  solanaOffchain,
} from "@estoc/identity";
import { encodeObject, encodeSchema, type Json, json, type Schema } from "@estoc/object";
import { defaultValidator } from "@estoc/object/default-validator";
import { MemoryBackend, Store } from "@estoc/store";
import { onTestFinished } from "vitest";
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
  type OriginData,
  originSchema,
  type PickupAnswerData,
  type PickupRequestData,
  pickupAnswerSchema,
  pickupRequestSchema,
  type ServiceData,
  serviceSchema,
} from "../src/index.ts";
import { type Accounts, loadMailboxService, type Mailboxes, MemoryAccounts, MemoryMailboxes } from "../src/server.ts";

export const schemes: readonly CurveScheme[] = [ed25519, eip191, solanaOffchain];
export const signer = (scheme: CurveScheme, fill: number) =>
  SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
export const memoryStore = () => new Store(json, new MemoryBackend());

/** A path to a file in a folder of its own, which is removed once the test finishes. */
export async function makeTemporaryPath(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "mailbox-service-"));
  onTestFinished(() => rm(folder, { recursive: true }));
  return join(folder, "service.db");
}

export const { keys, identities, signedIdentities, identityVersions, signatures, publish } =
  await loadIdentity(schemes);
export const actorOf = async (by: Signer) => signatures.actor(by, await publish(by, { at: 0 }));
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
export const pickupAnswerSchemaRead: Schema<Json, PickupAnswerData> = await encodeSchema(
  pickupAnswerSchema,
  defaultValidator,
);
export const originSchemaRead: Schema<Json, OriginData> = await encodeSchema(originSchema, defaultValidator);

export const terms: MailboxTerms = { retention: 60_000, quota: 4096, size: 1024 };

export const serviceSigner = signer(ed25519, 9);
export const serviceRoot = keys.encode(serviceSigner.key);
/** The Identity a service by `serviceSigner` signs when it first starts, at `start`. */
export const serviceIdentity = (start: number) => identities.encode(serviceSigner.key, { at: start });
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
  offeredTerms = terms,
  clock,
  accounts = new MemoryAccounts(),
  mailboxes = new MemoryMailboxes(),
}: {
  readonly start?: number;
  readonly by?: Signer;
  readonly origin?: string;
  readonly store?: Store;
  readonly offeredTerms?: MailboxTerms;
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
    terms: offeredTerms,
    validator: defaultValidator,
    schemes,
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
  const signedServices = await Promise.all(
    origins.map(async (origin) => {
      const object = encodeObject(serviceSchemaRead, { ...service, origin });
      return { object, signature: await actor.sign(object) };
    }),
  );
  return signedServices.sort((a, b) => (a.signature.link < b.signature.link ? 1 : -1));
}
