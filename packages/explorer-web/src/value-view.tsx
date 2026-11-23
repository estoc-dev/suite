import { isValueMap, LinkValue, type Value } from "@estoc/object";
import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { hexOf, quantityOf } from "./text.ts";

export function valueView(value: Value | undefined): JSX.Element {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof LinkValue)
    return (
      <span class="mono address" title={value.link}>
        {value.link}
      </span>
    );
  if (value instanceof Uint8Array)
    return (
      <>
        <span class="muted">{quantityOf(value.length, "byte", "bytes")} </span>
        <span class="mono bytes">{hexOf(value)}</span>
      </>
    );
  if (Array.isArray(value))
    return (
      <ul class="items">
        <For each={value as readonly Value[]}>{(item) => <li>{valueView(item)}</li>}</For>
      </ul>
    );
  if (isValueMap(value))
    return <span class="muted">map · {quantityOf(Object.keys(value).length, "member", "members")}</span>;
  return <span class="mono">{String(value)}</span>;
}
