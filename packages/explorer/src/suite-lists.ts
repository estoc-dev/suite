import { heldKeys } from "@estoc/keyring";
import { heldMailboxKeys, signedIdentityArrivals } from "@estoc/mailbox";
import { openedMailboxes, recordedSignatures } from "@estoc/mailbox-service";
import { listOfIndex } from "./list.ts";

export const suiteLists = [
  listOfIndex(heldKeys),
  listOfIndex(heldMailboxKeys),
  listOfIndex(signedIdentityArrivals),
  listOfIndex(openedMailboxes),
  listOfIndex(recordedSignatures),
];
