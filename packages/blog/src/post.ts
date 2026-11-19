import { type DataOf, link, optional, schema, string } from "@estoc/schema";

/** `date` is the day the post is published, written as in `2026-10-20`. */
export const postSchema = schema("Post", {
  title: string(),
  description: optional(string()),
  date: string(),
  body: link(),
});

export type PostData = DataOf<typeof postSchema>;
