import { heldKeys } from "@estoc/keyring";
import { heldMailboxKeys } from "@estoc/mailbox";
import { listOfIndex } from "./list.ts";

export const suiteLists = [listOfIndex(heldKeys), listOfIndex(heldMailboxKeys)];
