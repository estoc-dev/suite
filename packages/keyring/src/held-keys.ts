import { secretKeySchema } from "@estoc/identity";
import { link, schema } from "@estoc/schema";
import { indexOfRows, recordedStatement } from "@estoc/store";

const heldKeySchema = schema("Held Key", { key: link(), secretKey: link() });

const secretKey = recordedStatement(secretKeySchema);

export const heldKeys = indexOfRows(heldKeySchema, {
  key: secretKey.field("key"),
  secretKey: secretKey.link,
}).orderedBy("key");
