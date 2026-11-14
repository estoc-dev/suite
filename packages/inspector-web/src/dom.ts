export type Child = Node | string | false | undefined;
type Attribute = string | boolean | undefined | ((event: Event) => void);

/**
 * An element with attributes, `on…` listeners and children.
 *
 * - A string child is text, so what a file holds is shown and not read as markup.
 * - A false or missing child or attribute is left out.
 */
export function h(tag: string, attributes: Record<string, Attribute> | null = null, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") node.addEventListener(name.slice(2).toLowerCase(), value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) if (child !== false && child !== undefined) node.append(child);
  return node;
}

export const mono = (text: string, className = "") => h("span", { class: `mono ${className}`.trimEnd() }, text);

export const muted = (text: string) => h("span", { class: "muted" }, text);
