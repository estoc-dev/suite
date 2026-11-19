import type { Link } from "@estoc/object";
import { fragmentOf } from "./address.ts";
import { h } from "./dom.ts";

export const linkView = (link: Link<unknown>) => h("a", { class: "mono link", href: fragmentOf(link) }, link);
