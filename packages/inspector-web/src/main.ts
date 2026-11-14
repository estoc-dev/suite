import { type Bundle, decodeBundle } from "@estoc/bundle";
import { type Inspection, inspect } from "@estoc/inspector";
import { linkIn } from "./address.ts";
import { blobListOf, type ListedBlob } from "./blob-list.ts";
import { blobListView } from "./blob-list-view.ts";
import { type Child, h, mono, muted } from "./dom.ts";
import { inspectionView } from "./inspection-view.ts";
import { latestOnly } from "./latest.ts";
import { messageOf, sizeOf } from "./text.ts";

interface Refusal {
  readonly kind: "refused";
  readonly name: string;
  readonly error: unknown;
}

interface OpenFile {
  readonly kind: "open";
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly bundle: Bundle;
  readonly blobs: readonly ListedBlob[];
}

/** A file, and what the link being shown reads as through its bundle. */
type ShownFile = OpenFile & { readonly inspection: Inspection };

type Page = { readonly kind: "closed" } | Refusal | ShownFile;

const app = document.querySelector("#app") as HTMLElement;

let chosenFile: Promise<OpenFile | Refusal> | undefined;

const drawLatest = latestOnly(draw);

const show = () => void drawLatest(pageOf(chosenFile, location.hash));

// The links of one file are mostly absent from the next, so a file opens at its root.
function open(file: File): void {
  chosenFile = chosenFileOf(file);
  history.replaceState(null, "", location.pathname + location.search);
  show();
}

async function chosenFileOf(file: File): Promise<OpenFile | Refusal> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bundle: Bundle;
  try {
    bundle = decodeBundle(bytes);
  } catch (error) {
    return { kind: "refused", name: file.name, error };
  }
  return { kind: "open", name: file.name, bytes, bundle, blobs: await blobListOf(bundle) };
}

/** The page of the file chosen last at the link that `fragment` names, or at its root when it names none. */
async function pageOf(chosen: Promise<OpenFile | Refusal> | undefined, fragment: string): Promise<Page> {
  const file = await chosen;
  if (file === undefined) return { kind: "closed" };
  if (file.kind === "refused") return file;
  return { ...file, inspection: await inspect(linkIn(fragment) ?? file.bundle.link, file.bundle) };
}

function filePicker(label: string): HTMLElement {
  const input = h("input", {
    type: "file",
    onChange: () => {
      const file = (input as HTMLInputElement).files?.[0];
      if (file !== undefined) open(file);
    },
  });
  return h("label", { class: "button" }, label, input);
}

function refusal(name: string, error: unknown): HTMLElement {
  const cause = error instanceof Error ? error.cause : undefined;
  return h(
    "div",
    { class: "refusal", role: "alert" },
    h("p", null, mono(name), " is not a bundle: ", messageOf(error), "."),
    cause !== undefined && h("p", { class: "note" }, messageOf(cause)),
  );
}

function openView(...above: Child[]): HTMLElement {
  return h(
    "main",
    null,
    ...above,
    h(
      "section",
      { class: "drop" },
      h("p", null, "Drop an ", mono(".eof"), " file anywhere on the page, or choose one."),
      filePicker("Choose a file…"),
      h("p", { class: "note" }, "The file is read in this page, and is sent nowhere."),
    ),
  );
}

function fileView({ bundle, blobs, inspection }: ShownFile): HTMLElement {
  const isAbsent = inspection.kind === "absent";
  return h(
    "main",
    null,
    h("h1", null, inspection.link === bundle.link ? "Root" : isAbsent ? "Absent" : "Blob"),
    inspectionView(inspection),
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

function draw(page: Page): void {
  const fileSummary = page.kind === "open" && h("span", null, mono(page.name), muted(` · ${sizeOf(page.bytes)}`));
  app.replaceChildren(
    h(
      "header",
      null,
      h("span", { class: "brand" }, "Inspector"),
      fileSummary,
      page.kind === "open" && filePicker("Open another…"),
    ),
    page.kind === "open" ? fileView(page) : openView(page.kind === "refused" && refusal(page.name, page.error)),
  );
  window.scrollTo(0, 0);
}

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("over");
});
window.addEventListener("dragleave", () => document.body.classList.remove("over"));
window.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("over");
  const file = event.dataTransfer?.files[0];
  if (file !== undefined) open(file);
});
window.addEventListener("hashchange", show);

show();
