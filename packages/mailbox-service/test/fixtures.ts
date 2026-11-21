import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CurveScheme,
  ed25519,
  eip191,
  loadIdentity,
  type SignedIdentityObject,
  type Signer,
  SoftwareSigner,
  solanaOffchain,
} from "@estoc/identity";
import type { Keyring } from "@estoc/keyring";
import { encodeObject, type Link, linkOf, objectsOf } from "@estoc/object";
import { type Backend, MemoryBackend, recordSchema, Store } from "@estoc/store";
import { onTestFinished } from "vitest";
import { type Accounts, MemoryAccounts } from "../src/accounts.ts";
import { type MailboxTerms, type ServiceData, serviceSchema } from "../src/index.ts";
import { type Mailboxes, MemoryMailboxes } from "../src/mailboxes.ts";
import { setUpNotary } from "../src/notary.ts";
import { loadMailboxService } from "../src/server.ts";

export const schemes: readonly CurveScheme[] = [ed25519, eip191, solanaOffchain];
export const signer = (scheme: CurveScheme, fill: number) =>
  SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));

export const memoryStore = (backend: Backend = new MemoryBackend()): Store => new Store(backend);

/** The bytes of the object that a key, a signed identity or a signature is read from, which its blobs hold. */
export function bytesOf({ link, blobs }: { readonly link: Link<unknown>; readonly blobs: readonly Uint8Array[] }) {
  const bytes = blobs.find((each) => linkOf(each) === link);
  if (bytes === undefined) throw new Error(`the blobs of ${link} do not hold it`);
  return bytes;
}

/** The links of the objects that the records among the marks of `store` link to, in the order of the records. */
export async function recordedObjectsIn(store: Store): Promise<Link<never>[]> {
  const links: Link<never>[] = [];
  for await (const mark of store.marks()) {
    const record = await objectsOf(recordSchema).read(mark, store);
    if (record !== undefined) links.push(record.data.object.link as Link<never>);
  }
  return links;
}

/** A path to a file in a folder of its own, which is removed once the test finishes. */
export async function makeTemporaryPath(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "mailbox-service-"));
  onTestFinished(() => rm(folder, { recursive: true }));
  return join(folder, "service.db");
}

const kit = loadIdentity(schemes);
export const { keys, identities, signedIdentities, signatures, publish } = kit;

/** A keyring that holds the Secret Key of `by` alone. */
export const keyringOf = (by: Signer): Pick<Keyring, "signerFor"> => ({
  signerFor: async (key) => (key === keys.encode(by.key).link ? by : undefined),
});

export const identityVersionInHand = async <T>(inHand: T) => inHand;
/** An actor that signs by `signedIdentity` whatever a store holds, with the signed identity for the tests to read. */
export const actorSigningBy = (by: Signer, signedIdentity: SignedIdentityObject) => ({
  ...signatures.actor(by, signedIdentity, identityVersionInHand),
  signedIdentity,
});
export const actorOf = async (by: Signer) => actorSigningBy(by, await publish(by, { at: 0 }));
export const terms: MailboxTerms = { retention: 60_000, quota: 4096, size: 1024 };

export const serviceSigner = signer(ed25519, 9);
export const serviceRoot = keys.encode(serviceSigner.key);
/** The Identity that a service by `serviceSigner` signs when it is set up at `start`. */
export const serviceIdentity = (start: number) => identities.encode(serviceSigner.key, { at: start });
/** An actor for that Identity, which signs as the service does. */
export const serviceActor = async (start: number) =>
  actorSigningBy(serviceSigner, await signedIdentities.sign(serviceSigner, serviceIdentity(start)));

export async function setUpService({
  start = 1_000,
  by = serviceSigner,
  store,
}: {
  readonly start?: number;
  readonly by?: Signer;
  readonly store: Store;
}) {
  return setUpNotary(keyringOf(by), keys.encode(by.key).link, { kit, store, at: start });
}

async function recordsIdentityVersion(store: Store): Promise<boolean> {
  for (const link of await recordedObjectsIn(store))
    if ((await objectsOf(signedIdentities.schema).read(link, store)) !== undefined) return true;
  return false;
}

/**
 * A service that keeps everything in memory, and whose clock counts up a
 * millisecond a reading from `start`, or stands at `clock.now` when it is
 * given, which a test moves. Given the store of another, with its accounts
 * and its mailboxes, it is that service started again. It is set up as
 * `setUpService` does unless its store records an identity version.
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
  if (!(await recordsIdentityVersion(store))) await setUpService({ start, by, store });
  let now = start;
  const service = await loadMailboxService(keyringOf(by), {
    origin,
    store,
    accounts,
    mailboxes,
    terms: offeredTerms,
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
      const object = encodeObject(serviceSchema, { ...service, origin });
      return { object, signature: await actor.sign(object) };
    }),
  );
  return signedServices.sort((a, b) => (a.signature.link < b.signature.link ? 1 : -1));
}
