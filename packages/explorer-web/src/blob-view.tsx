import type { Link, Reader } from "@estoc/object";
import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { type BlobPage, readBlobPage } from "./blob-page.ts";
import { objectView } from "./object-view.tsx";
import { hexOf, quantityOf } from "./text.ts";

export function blobPageView({ inspection, reading }: BlobPage): JSX.Element {
  if (inspection.kind === "object") return objectView(inspection, reading);
  if (inspection.kind === "absent")
    return (
      <>
        <dl class="head">
          <dt>Link</dt>
          <dd class="mono">{inspection.link}</dd>
        </dl>
        <p class="note">The runtime gives no blob for it.</p>
      </>
    );
  const { bytes } = inspection;
  return (
    <>
      <dl class="head">
        <dt>Link</dt>
        <dd class="mono">{inspection.link}</dd>
        <dt>Size</dt>
        <dd>{quantityOf(bytes.length, "byte", "bytes")}</dd>
      </dl>
      <p class="note">Not an object of the Estoc Object Format: bytes, which link to nothing.</p>
      {bytes.length > 0 && <p class="mono bytes dump">{hexOf(bytes)}</p>}
    </>
  );
}

export function BlobView(props: { reader: Reader; link: Link<unknown> }) {
  const page = createMemo(() => readBlobPage(props.reader, props.link));
  return (
    <>
      <h1>Blob</h1>
      <section class="card">{blobPageView(page())}</section>
    </>
  );
}
