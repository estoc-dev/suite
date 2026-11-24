import { signedIdentitySchema } from "@estoc/identity";
import { arrivalsView } from "@estoc/store";

export const signedIdentityArrivalsView = arrivalsView(signedIdentitySchema);

export const signedIdentityArrivals = signedIdentityArrivalsView.index.named("Arrivals of Roots and Signed Identities");
