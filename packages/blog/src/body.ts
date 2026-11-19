import { type EncodedObject, encodeObject, type Implementation, Implementations, type Link } from "@estoc/object";
import { type DataOf, schema, string } from "@estoc/schema";
import { micromark } from "micromark";

/**
 * What the object of a post's body reads as, whichever schema it is written to: the body rendered
 * as HTML, with the link of the object it is read from.
 */
export interface Body {
  readonly link: Link<unknown>;
  readonly html: string;
}

export const markdownBodySchema = schema("Markdown Body", { text: string() });

export type MarkdownBodyData = DataOf<typeof markdownBodySchema>;

/**
 * A Markdown body, read as CommonMark. HTML written in the text is rendered as text and not as
 * markup, so the body of a post written by anyone can be put on a page.
 */
export const markdownBody: Implementation<Body, MarkdownBodyData> = {
  schema: markdownBodySchema,
  read: ({ link, data }) => ({ link, html: micromark(data.text) }),
};

/** The object of a Markdown body that holds `text`, for a post to name by its link. */
export function markdownBodyOf(text: string): EncodedObject<MarkdownBodyData> {
  return encodeObject(markdownBodySchema, { text });
}

/** The body schemas read here. A program that reads others lists them in a table of its own. */
export const bodies = new Implementations([markdownBody]);
