import { ed25519, loadIdentity, SoftwareSigner } from "@estoc/identity";
import { peopleView } from "@estoc/people";
import { MemoryBackend, PrivateStore, Store, view } from "@estoc/store";
import { loadServices } from "./client.ts";

// Anyone who reads this can sign as the test identity, which is all right
// for an account that only tests a service. Nothing here opens what is sealed
// to the mailbox's key, so any 32 bytes do for it.
const IDENTITY_KEY = new Uint8Array(32).fill(1);
const MAILBOX_KEY = new Uint8Array(32).fill(2);

export interface TestMailbox {
  readonly url: string;
  pickUp(): Promise<Uint8Array[]>;
}

/**
 * The identity is published at time 0, so each run signs the same acceptance and reaches the same
 * account. While the service offers mailboxes on the same terms, each run signs the same request
 * too, and reaches the same mailbox.
 */
export async function openTestMailbox(origin: string): Promise<TestMailbox> {
  const { signatures, signedIdentities, publish } = loadIdentity([ed25519]);
  const signer = SoftwareSigner.fromSecretKey(ed25519, IDENTITY_KEY);
  const store = new Store(new MemoryBackend());
  const seenPeople = peopleView({ signedIdentities });
  const actor = signatures.actor(signer, await publish(signer, { at: 0 }), async (inHand) =>
    (await view(store, seenPeople)).current(inHand),
  );
  const services = loadServices(store, new PrivateStore(store, new MemoryBackend()), { schemes: [ed25519] });
  const { account, mailbox: offer } = await services.fetch(origin);
  if (account === undefined || offer === undefined) throw new Error(`${origin} offers no account or no mailboxes`);
  await account.accept(actor);
  const mailbox = await offer.open(actor, MAILBOX_KEY);
  return {
    url: mailbox.data.url,
    async pickUp() {
      const ciphertexts: Uint8Array[] = [];
      for await (const arrival of (await services.pickup(mailbox.link, actor)).arrivals()) {
        ciphertexts.push(arrival.ciphertext);
        await arrival.drop();
      }
      return ciphertexts;
    },
  };
}

export async function smoke(origin: string): Promise<void> {
  const mailbox = await openTestMailbox(origin);
  const message = new TextEncoder().encode(`smoke test at ${new Date().toISOString()}`);
  const response = await fetch(mailbox.url, { method: "POST", body: message });
  if (response.status !== 204) throw new Error(`${mailbox.url} answered ${response.status}: ${await response.text()}`);
  const ciphertexts = await mailbox.pickUp();
  if (!ciphertexts.some((ciphertext) => Buffer.from(ciphertext).equals(message)))
    throw new Error(`the pickup at ${origin} did not bring the message`);
}

if (import.meta.main) {
  const [origin, ...rest] = process.argv.slice(2);
  if (origin === undefined || rest.length > 0) {
    console.error("Usage: smoke.ts <origin>");
    process.exitCode = 1;
  } else {
    await smoke(origin);
    console.log(`${origin} took a message and handed it back`);
  }
}
