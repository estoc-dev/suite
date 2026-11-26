import { heldKeys } from "@estoc/keyring";
import { heldMailboxKeys, mailboxGrants, signedIdentityArrivalsView } from "@estoc/mailbox";
import {
  acknowledgements,
  locations,
  openedMailboxes,
  recordedIdentityVersions,
  recordedSignatures,
} from "@estoc/mailbox-service";
import { identityVersions } from "@estoc/people";
import { listOfIndex } from "./list.ts";

export const suiteLists = [
  listOfIndex(heldKeys, "Held Keys"),
  listOfIndex(identityVersions, "Identity Versions"),
  listOfIndex(heldMailboxKeys, "Held Mailbox Keys"),
  listOfIndex(mailboxGrants, "Mailbox Grants"),
  listOfIndex(signedIdentityArrivalsView.index, "Arrivals of Roots and Signed Identities"),
  listOfIndex(locations, "Locations"),
  listOfIndex(acknowledgements, "Acknowledgements"),
  listOfIndex(openedMailboxes, "Opened Mailboxes"),
  listOfIndex(recordedIdentityVersions, "Recorded Identity Versions"),
  listOfIndex(recordedSignatures, "Recorded Signatures"),
];
