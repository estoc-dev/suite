import { type SignedIdentityData, signedIdentitySchema } from "@estoc/identity";
import { actorFor } from "@estoc/keyring";
import { type MailboxData, type MailboxKeyData, mailboxKeySchema, Post, type PostOptions } from "@estoc/mailbox";
import { httpTransport } from "@estoc/mailbox/http";
import { type EncodedObject, LinkValue } from "@estoc/object";
import { array, link, schema, string } from "@estoc/schema";
import { actionOver } from "@estoc/store";
import { loadServices } from "./client.ts";
import { type AccountOfferData, accountOfferSchema, type MailboxOfferData, mailboxOfferSchema } from "./schemas.ts";

type Environment = Pick<PostOptions, "clock">;

const signedIdentityLink = () => link<EncodedObject<SignedIdentityData>>();
const mailboxKeyLink = () => link<EncodedObject<MailboxKeyData>>();

export const fetchService = actionOver(
  schema("Fetch Service", { origin: string() }),
  schema("Fetched Service", { service: link() }),
  async ({ origin }, store, { clock = Date.now }: Environment) => {
    const service = await loadServices(store, { clock }).fetch(origin);
    return { service: new LinkValue(service.link) };
  },
);

export const acceptAccountOffer = actionOver(
  schema("Accept Account Offer", { actor: signedIdentityLink(), offer: link<EncodedObject<AccountOfferData>>() }),
  schema("Accepted Account Offer", { acknowledgement: link() }),
  async ({ actor, offer }, store, { clock = Date.now }: Environment) => {
    const accountOffer = await loadServices(store, { clock }).accountOffer(offer.link);
    const account = await accountOffer.accept(await actorFor(actor.link, store));
    return { acknowledgement: new LinkValue(account.link) };
  },
)
  .taking("actor", signedIdentitySchema)
  .taking("offer", accountOfferSchema);

export const openInbox = actionOver(
  schema("Open Inbox", { actor: signedIdentityLink(), offer: link<EncodedObject<MailboxOfferData>>() }),
  schema("Opened Inbox", { mailbox: link<EncodedObject<MailboxData>>(), mailboxKey: mailboxKeyLink() }),
  async ({ actor, offer }, store, { clock = Date.now }: Environment) => {
    const mailboxOffer = await loadServices(store, { clock }).mailboxOffer(offer.link);
    const signingActor = await actorFor(actor.link, store);
    // The transport object that a service gives is an HTTP one, so the post needs that transport alone.
    const post = new Post(store, { transports: [httpTransport], clock });
    const inbox = await post.openInbox((publicKey) => mailboxOffer.open(signingActor, publicKey));
    return { mailbox: new LinkValue(inbox.mailbox), mailboxKey: new LinkValue(inbox.key) };
  },
)
  .taking("actor", signedIdentitySchema)
  .taking("offer", mailboxOfferSchema);

export const collect = actionOver(
  schema("Collect", { actor: signedIdentityLink(), mailboxKey: mailboxKeyLink() }),
  schema("Collected Bundles", { inbounds: array(link<EncodedObject>()) }),
  async ({ actor, mailboxKey }, store, { clock = Date.now }: Environment) => {
    // An inbox is found by its key and collects from a pickup, so the post needs no transport.
    const inbox = await new Post(store, { transports: [], clock }).inbox(mailboxKey.link);
    const pickup = await loadServices(store, { clock }).pickup(inbox.mailbox, await actorFor(actor.link, store));
    const deliveries = await inbox.collect(pickup);
    return { inbounds: deliveries.map((delivery) => new LinkValue(delivery.link)) };
  },
)
  .taking("actor", signedIdentitySchema)
  .taking("mailboxKey", mailboxKeySchema);
