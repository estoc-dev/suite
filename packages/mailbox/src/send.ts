import { type EncodedObject, LinkValue } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { actionOver } from "@estoc/store";
import { Post, type PostOptions } from "./post.ts";
import type { MailboxData } from "./schema.ts";

export const send = actionOver(
  schema("Send", { root: link(), mailbox: link<EncodedObject<MailboxData>>() }),
  schema("Sent Bundle", { outbound: link<EncodedObject>() }),
  async ({ root, mailbox }, store, environment: PostOptions) => {
    const outbox = await new Post(store, environment).outbox(mailbox.link);
    const outbound = await outbox.send(root.link);
    return { outbound: new LinkValue(outbound.link) };
  },
);
