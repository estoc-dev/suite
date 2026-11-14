import { type Bundle, decodeBundle } from "@estoc/bundle";
import { type Inspection, inspect } from "@estoc/inspector";
import { type Child, h, mono, muted } from "./dom.ts";
import { objectView } from "./object-view.ts";
import { messageOf, sizeOf } from "./text.ts";

type Page =
  | { readonly kind: "closed" }
  | { readonly kind: "refused"; readonly name: string; readonly error: unknown }
  | { readonly kind: "open"; readonly name: string; readonly file: Uint8Array; readonly root: Inspection };

const app = document.querySelector("#app") as HTMLElement;

async function open(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bundle: Bundle;
  try {
    bundle = decodeBundle(bytes);
  } catch (error) {
    draw({ kind: "refused", name: file.name, error });
    return;
  }
  draw({ kind: "open", name: file.name, file: bytes, root: await inspect(bundle.link, bundle) });
}

function filePicker(label: string): HTMLElement {
  const input = h("input", {
    type: "file",
    onChange: () => {
      const file = (input as HTMLInputElement).files?.[0];
      if (file !== undefined) void open(file);
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

function inspectionView(inspection: Inspection): HTMLElement {
  if (inspection.kind === "object") return objectView(inspection);
  return h("p", { class: "note" }, mono(inspection.link), ` reads as ${inspection.kind}.`);
}

function draw(page: Page): void {
  const opened = page.kind === "open" && h("span", null, mono(page.name), muted(` · ${sizeOf(page.file)}`));
  app.replaceChildren(
    h(
      "header",
      null,
      h("span", { class: "brand" }, "Inspector"),
      opened,
      page.kind === "open" && filePicker("Open another…"),
    ),
    page.kind === "open"
      ? h("main", null, h("h1", null, "Root"), inspectionView(page.root))
      : openView(page.kind === "refused" && refusal(page.name, page.error)),
  );
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
  if (file !== undefined) void open(file);
});

draw({ kind: "closed" });
