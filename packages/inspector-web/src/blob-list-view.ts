import type { Inspection } from "@estoc/inspector";
import type { Link } from "@estoc/object";
import type { ListedBlob } from "./blob-list.ts";
import { type Child, h, muted } from "./dom.ts";
import { linkView } from "./link-view.ts";
import { sizeOf } from "./text.ts";

// A title is the one the schema gave itself, so the link of the schema stands beside it here too.
function summaryOf(inspection: Inspection): Child {
  if (inspection.kind === "absent") return muted("absent");
  if (inspection.kind === "bytes") return muted("bytes");
  const { schema } = inspection;
  if (schema.kind === "schema")
    return [h("span", { class: "title" }, schema.document.title), " ", linkView(schema.link)];
  return [
    muted("object written to "),
    linkView(schema.link),
    muted(schema.kind === "absent" ? ", for which no blob is given" : ", which is not a schema of Estoc Schema"),
  ];
}

function blobView({ bytes, inspection, isRoot, isReachedFromRoot }: ListedBlob, isShown: boolean): HTMLElement {
  return h(
    "li",
    { "aria-current": isShown && "true" },
    h(
      "div",
      { class: "line" },
      linkView(inspection.link),
      isRoot && h("span", { class: "mark" }, "root"),
      !isReachedFromRoot && h("span", { class: "mark" }, "not reached from the root"),
    ),
    h(
      "div",
      { class: "line" },
      h("span", null, summaryOf(inspection)),
      h("span", { class: "muted size" }, sizeOf(bytes)),
    ),
  );
}

/** The blobs of a file, each with what it reads as. The one that `shownLink` names is marked as shown. */
export function blobListView(blobs: readonly ListedBlob[], shownLink: Link<unknown>): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h(
      "ul",
      { class: "blobs" },
      blobs.map((blob) => blobView(blob, blob.inspection.link === shownLink)),
    ),
  );
}
