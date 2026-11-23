import { type Body, bodies } from "@estoc/blog";
import type { ReadingAs } from "./reading.ts";

export const bodyReading: ReadingAs<Body> = {
  name: "the body of a post",
  implementations: bodies,
  // The markup is what `bodies` rendered, which shows HTML written in the text as text.
  viewOf: ({ html }) => <div class="rendered" innerHTML={html} />,
};
