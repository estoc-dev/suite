import { heldKeys } from "@estoc/keyring";
import { heldMailboxKeys, signedIdentityArrivals } from "@estoc/mailbox";
import { openedMailboxes, recordedSignatures } from "@estoc/mailbox-service";
import { identityVersions } from "@estoc/people";
import { listOfIndex } from "./list.ts";

export const suiteLists = [
  listOfIndex(heldKeys),
  listOfIndex(identityVersions),
  listOfIndex(heldMailboxKeys),
  listOfIndex(signedIdentityArrivals),
  listOfIndex(openedMailboxes),
  listOfIndex(recordedSignatures),
];
