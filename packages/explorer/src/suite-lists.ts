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
  listOfIndex(heldKeys, "Held Keys", ["key"]),
  listOfIndex(identityVersions, "Identity Versions", ["identifier", "at", "signedIdentity"]),
  listOfIndex(heldMailboxKeys, "Held Mailbox Keys", ["key"]),
  listOfIndex(mailboxGrants, "Mailbox Grants", ["from", "to", "at", "signature"]),
  listOfIndex(signedIdentityArrivalsView.index, "Arrivals of Roots and Signed Identities", ["object", "at"]),
  listOfIndex(locations, "Locations", ["identifier", "at", "service"]),
  listOfIndex(acknowledgements, "Acknowledgements", ["acceptance", "acknowledgement"]),
  listOfIndex(openedMailboxes, "Opened Mailboxes", ["transport", "acknowledgement"]),
  listOfIndex(recordedIdentityVersions, "Recorded Identity Versions", ["identifier", "signedIdentity"]),
  listOfIndex(recordedSignatures, "Recorded Signatures", ["object", "signature"]),
];
