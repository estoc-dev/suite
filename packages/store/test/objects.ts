import { type EncodedObject, type Reader, readObjectNaming, type Schema, type ValueMap } from "@estoc/object";
import { type Index, indexOver, type Source } from "../src/index.ts";

/** The rows that `rows` gives of each object that names `objectSchema` among the blobs of `source`. */
export function indexOverObjects<S extends ValueMap, F extends ValueMap>(
  source: Source,
  objectSchema: Schema<S>,
  rowSchema: Schema<F>,
  rows: (object: EncodedObject<S>, reader: Reader) => Iterable<NoInfer<F>> | AsyncIterable<NoInfer<F>>,
): Index<F> {
  return indexOver(source, rowSchema, async function* ({ link }, reader) {
    const object = await readObjectNaming(reader, link, objectSchema);
    if (object !== undefined) yield* rows(object, reader);
  });
}

/** The rows that `rows` gives of each row of `index`. */
export function indexOverRows<S extends ValueMap, F extends ValueMap>(
  index: Index<S>,
  rowSchema: Schema<F>,
  rows: (row: EncodedObject<S>, reader: Reader) => Iterable<NoInfer<F>> | AsyncIterable<NoInfer<F>>,
): Index<F> {
  return indexOverObjects(index, index.rowSchema, rowSchema, rows);
}
