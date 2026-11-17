import { blobListView } from "./blob-list-view.ts";
import { type Child, h, mono, muted } from "./dom.ts";
import { inspectionView } from "./inspection-view.ts";
import type { Page, ReadFailure, Refusal, ShownFile } from "./page.ts";
import { messageOf, sizeOf } from "./text.ts";

type Open = (file: File) => void;

function filePicker(label: string, open: Open): HTMLElement {
  const input = h("input", {
    type: "file",
    onChange: () => {
      const file = (input as HTMLInputElement).files?.[0];
      if (file !== undefined) open(file);
    },
  });
  return h("label", { class: "button" }, label, input);
}

function failureView({ kind, name, error }: ReadFailure | Refusal): HTMLElement {
  const cause = error instanceof Error ? error.cause : undefined;
  return h(
    "div",
    { class: "failure", role: "alert" },
    kind === "unread"
      ? [h("p", null, mono(name), " could not be read."), h("p", { class: "note" }, messageOf(error))]
      : [
          h("p", null, mono(name), " is not a bundle: ", messageOf(error), "."),
          cause !== undefined && h("p", { class: "note" }, messageOf(cause)),
        ],
  );
}

function openView(open: Open, above: Child): HTMLElement {
  return h(
    "main",
    null,
    above,
    h(
      "section",
      { class: "drop" },
      h("p", null, "Drop an ", mono(".eof"), " file anywhere on the page, or choose one."),
      filePicker("Choose a file…", open),
      h("p", { class: "note" }, "The file is read in this page, and is sent nowhere."),
    ),
  );
}

function fileView({ bundle, blobs, inspection, reading }: ShownFile): HTMLElement {
  const isAbsent = inspection.kind === "absent";
  return h(
    "main",
    null,
    h("h1", null, inspection.link === bundle.link ? "Root" : isAbsent ? "Absent" : "Blob"),
    inspectionView(inspection, reading),
    isAbsent &&
      h(
        "p",
        { class: "note" },
        "A bundle need not be complete: it can leave out a blob that its reader already holds.",
      ),
    h("h2", null, "Blobs in the file ", muted(`· ${blobs.length}`)),
    blobListView(blobs, inspection.link),
  );
}

/**
 * What the page holds: its header, then the file being shown or the place to choose one.
 *
 * A file that could not be read, or is not a bundle, leaves nothing of the file before it to follow.
 */
export function pageView(page: Page, open: Open): HTMLElement[] {
  const isOpen = page.kind === "open";
  return [
    h(
      "header",
      null,
      h("span", { class: "brand" }, "Inspector"),
      isOpen && h("span", null, mono(page.name), muted(` · ${sizeOf(page.bytes)}`)),
      isOpen && filePicker("Open another…", open),
    ),
    isOpen ? fileView(page) : openView(open, page.kind !== "closed" && failureView(page)),
  ];
}
