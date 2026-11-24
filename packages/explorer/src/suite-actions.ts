import { generateKey } from "@estoc/keyring";
import { grant, type PostOptions, send, sendTo } from "@estoc/mailbox";
import { acceptAccountOffer, collect, fetchService, openInbox } from "@estoc/mailbox-service";
import { type ListedAction, listedAction } from "./action.ts";

export function suiteActions(environment: PostOptions): ListedAction[] {
  return [
    listedAction(generateKey, environment),
    listedAction(send, environment),
    listedAction(grant, environment),
    listedAction(sendTo, environment),
    listedAction(fetchService, environment),
    listedAction(acceptAccountOffer, environment),
    listedAction(openInbox, environment),
    listedAction(collect, environment),
  ];
}
