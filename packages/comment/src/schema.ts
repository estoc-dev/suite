import { DRAFT_2020_12, type JsonLink, type JsonSchema, linkSchema } from "@estoc/object";

/**
 * The draft 2020-12 schema of a comment: `on`, the link of the blob it is
 * on, `text`, what it says, and `at`, when it was written, in milliseconds
 * since the Unix epoch by the clock of the device that wrote it. A comment
 * can be on any blob: an object, a schema, a file, or another comment.
 */
export const commentSchema: JsonSchema = {
  $schema: DRAFT_2020_12,
  title: "Comment",
  type: "object",
  properties: {
    on: linkSchema,
    text: { type: "string", minLength: 1 },
    at: { type: "integer", minimum: 0 },
  },
  required: ["on", "text", "at"],
  additionalProperties: false,
};

/** The data of a comment, as `commentSchema` describes it. */
export type CommentData = {
  readonly on: JsonLink<never>;
  readonly text: string;
  readonly at: number;
};
