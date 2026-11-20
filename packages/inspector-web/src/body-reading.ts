import { type Body, bodies } from "@estoc/blog";
import { markup } from "./dom.ts";
import type { ReadingAs } from "./reading.ts";

export const bodyReading: ReadingAs<Body> = {
  name: "the body of a post",
  implementations: () => bodies,
  viewOf: ({ html }) => markup("div", { class: "rendered" }, html),
};
