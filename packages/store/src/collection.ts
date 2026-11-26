import { type EncodedObject, encodeObject, type Link, LinkValue } from "@estoc/object";
import { array, type DataOf, link, schema } from "@estoc/schema";

/**
 * - A collection is a set of blobs. `members` holds the link of each once, in the order of the
 *   links as strings, so that the same members make the same object, with the same link.
 * - The schema language cannot say that order, so an object of this schema may list its members
 *   otherwise. That is not a collection: a store refuses it where it is asked for the collection,
 *   and what decodes the object itself is given the members as they are written.
 * - The members are the blobs listed and not their closures. They need not be objects, nor of one
 *   schema.
 * - A member can be a Record. The closure of the collection then holds the Record, and
 *   `sendableBlobs` refuses it.
 */
export const collectionSchema = schema("Collection", { members: array(link()) });

export type CollectionData = DataOf<typeof collectionSchema>;

export type Collection = EncodedObject<CollectionData>;

export function collectionOf(members: Iterable<Link<unknown>>): Collection {
  return encodeObject(collectionSchema, {
    members: [...new Set(members)].sort().map((member) => new LinkValue(member)),
  });
}

export function membersOf({ link, data }: Collection): readonly Link<unknown>[] {
  const members = data.members.map((member) => member.link);
  for (const [at, member] of members.entries()) {
    const previous = members[at - 1];
    if (previous === undefined || previous < member) continue;
    throw new Error(
      previous === member
        ? `${link} lists ${member} twice, and a collection lists each member once`
        : `${link} lists ${member} after ${previous}, and a collection lists its members in the order of their links`,
    );
  }
  return members;
}
