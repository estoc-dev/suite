import type { Inspection } from "@estoc/inspector";
import { h, mono } from "./dom.ts";
import { objectView } from "./object-view.ts";
import type { Reading } from "./reading.ts";
import { hexOf, sizeOf } from "./text.ts";

export function inspectionView(inspection: Inspection, reading?: Reading): HTMLElement {
  if (inspection.kind === "object") return objectView(inspection, reading);
  const link = [h("dt", null, "Link"), h("dd", null, mono(inspection.link))];
  if (inspection.kind === "absent")
    return h(
      "section",
      { class: "card" },
      h("dl", { class: "head" }, link),
      h("p", { class: "note" }, "No blob is given for it."),
    );
  const { bytes } = inspection;
  return h(
    "section",
    { class: "card" },
    h("dl", { class: "head" }, link, h("dt", null, "Size"), h("dd", null, sizeOf(bytes))),
    h("p", { class: "note" }, "Not an object of the Estoc Object Format: bytes, which link to nothing."),
    bytes.length > 0 && h("p", { class: "mono bytes dump" }, hexOf(bytes)),
  );
}
