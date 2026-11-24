import { heldKeys } from "@estoc/keyring";
import { heldMailboxKeys, identityVersionArrivals } from "@estoc/mailbox";
import { openedMailboxes, recordedSignatures } from "@estoc/mailbox-service";
import { listOfIndex } from "./list.ts";

export const suiteLists = [
  listOfIndex(heldKeys),
  listOfIndex(heldMailboxKeys),
  listOfIndex(identityVersionArrivals),
  listOfIndex(openedMailboxes),
  listOfIndex(recordedSignatures),
];
