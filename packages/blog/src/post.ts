import { type DataOf, link, optional, schema, string } from "@estoc/schema";

/**
 * The schema of a post: what is said of it, and the link of its body.
 *
 * - `date` is the day the post is published, written as in `2026-10-20`. The schema takes any
 *   string, so a program that uses it as a day checks that it is one.
 * - `body` names an object of whichever schema the body is written to. The post does not say
 *   which: a program reads the body with the body schemas it lists.
 */
export const postSchema = schema("Post", {
  title: string(),
  description: optional(string()),
  date: string(),
  body: link(),
});

export type PostData = DataOf<typeof postSchema>;
