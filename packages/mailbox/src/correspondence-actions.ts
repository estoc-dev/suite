import { identityKit, type SignedIdentityData, signedIdentitySchema } from "@estoc/identity";
import { actorFor } from "@estoc/keyring";
import { type EncodedObject, type Link, LinkValue } from "@estoc/object";
import { array, link, schema } from "@estoc/schema";
import { actionOver, type Store } from "@estoc/store";
import type { Correspondence } from "./correspondence.ts";
import { Post, type PostOptions } from "./post.ts";
import { type MailboxData, mailboxSchema } from "./schema.ts";

const { signedIdentities } = identityKit;
const signedIdentityLink = () => link<EncodedObject<SignedIdentityData>>();

async function correspondenceAs(actor: Link<unknown>, store: Store, options: PostOptions): Promise<Correspondence> {
  return new Post(store, options).correspondenceAs(await actorFor(actor, store));
}

export const grant = actionOver(
  schema("Grant", {
    actor: signedIdentityLink(),
    to: signedIdentityLink(),
    mailboxes: array(link<EncodedObject<MailboxData>>()),
  }),
  schema("Signed Grant", { signature: link() }),
  async ({ actor, to, mailboxes }, store, environment: Pick<PostOptions, "clock">) => {
    // A grant is signed and recorded, and goes out by no transport.
    const correspondence = await correspondenceAs(actor.link, store, { ...environment, transports: [] });
    const signature = await correspondence.grant(
      await signedIdentities.read(to.link, store),
      mailboxes.map((mailbox) => mailbox.link),
    );
    return { signature: new LinkValue(signature.link) };
  },
)
  .taking("actor", signedIdentitySchema)
  .taking("to", signedIdentitySchema)
  .taking("mailboxes", mailboxSchema);

export const sendTo = actionOver(
  schema("Send To", { actor: signedIdentityLink(), to: signedIdentityLink(), root: link() }),
  schema("Delivered Bundle", { outbounds: array(link<EncodedObject>()) }),
  async ({ actor, to, root }, store, environment: PostOptions) => {
    const correspondence = await correspondenceAs(actor.link, store, environment);
    const deliveries = await correspondence.send(await signedIdentities.read(to.link, store), root.link);
    return { outbounds: deliveries.map((delivery) => new LinkValue(delivery.link)) };
  },
)
  .taking("actor", signedIdentitySchema)
  .taking("to", signedIdentitySchema);
