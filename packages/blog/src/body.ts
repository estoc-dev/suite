import { type EncodedObject, encodeObject, type Implementation, Implementations, type Link } from "@estoc/object";
import { type DataOf, schema, string } from "@estoc/schema";
import { micromark } from "micromark";

/** The body of a post read from its object, whichever schema it is written to. */
export interface Body extends EncodedObject {
  readonly link: Link<Body>;
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
  read: (object) => bodyFrom(object, micromark(object.data.text)),
};

/** Writes `text` as a Markdown body. */
export function markdownBodyOf(text: string): Body {
  return bodyFrom(encodeObject(markdownBodySchema, { text }), micromark(text));
}

function bodyFrom(object: EncodedObject, html: string): Body {
  return { ...object, link: object.link as Link<Body>, html };
}

/** The body schemas read here. A program that reads others lists them in a table of its own. */
export const bodies = new Implementations([markdownBody]);
