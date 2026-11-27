import { secretKeySchema } from "@estoc/identity";
import { link, schema } from "@estoc/schema";
import { indexOfRows, memberOf, recordedStatements } from "@estoc/store";

const heldKeySchema = schema("Held Key", { key: link(), secretKey: link() });

const secretKey = memberOf(secretKeySchema);

export const heldKeys = indexOfRows(heldKeySchema, {
  key: secretKey.field("key"),
  secretKey: secretKey.link,
}).reading(recordedStatements);
