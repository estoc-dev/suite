import { signedIdentitySchema } from "@estoc/identity";
import { arrivalsView } from "@estoc/store";

export const identityVersionArrivalsView = arrivalsView(signedIdentitySchema);

export const identityVersionArrivals = identityVersionArrivalsView.index.named(
  "Arrivals of Roots and Identity Versions",
);
