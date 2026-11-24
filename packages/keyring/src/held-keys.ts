import { secretKeySchema } from "@estoc/identity";
import { LinkValue, objectsOf } from "@estoc/object";
import { link, schema } from "@estoc/schema";
import { indexOver, selectedRecords } from "@estoc/store";

const heldKeySchema = schema("Held Key", { key: link(), secretKey: link() });

export const heldKeys = indexOver(selectedRecords(objectsOf(secretKeySchema)), heldKeySchema, ({ link, data }) => [
  { key: data.key, secretKey: new LinkValue(link) },
])
  .orderedBy("key")
  .named("Held Keys");
