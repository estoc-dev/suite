import { type EncodedObject, encodeObject, type Implementation, Implementations, type Link } from "@estoc/object";
import { type DataOf, schema, string } from "@estoc/schema";
import { micromark } from "micromark";

export interface Body {
  readonly link: Link<unknown>;
  readonly html: string;
}

export const markdownBodySchema = schema("Markdown Body", { text: string() });

export type MarkdownBodyData = DataOf<typeof markdownBodySchema>;

/**
 * HTML written in the text is rendered as text and not as markup, so the body of a post written by
 * anyone can be put on a page.
 */
export const markdownBody: Implementation<Body, MarkdownBodyData> = {
  schema: markdownBodySchema,
  read: ({ link, data }) => ({ link, html: micromark(data.text) }),
};

export function markdownBodyOf(text: string): EncodedObject<MarkdownBodyData> {
  return encodeObject(markdownBodySchema, { text });
}

export const bodies = new Implementations([markdownBody]);
