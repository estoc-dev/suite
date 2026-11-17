export type Child = Node | string | false | undefined | readonly Child[];
type Attribute = string | boolean | undefined | ((event: Event) => void);

/**
 * An element with attributes, `on…` listeners and children.
 *
 * - A string child is text, so what a file holds is shown and not read as markup.
 * - A false or missing child or attribute is left out.
 * - An array child gives its children in turn. A list as long as a file makes it is passed as an
 *   array, since an engine takes only so many arguments in one call.
 */
export function h(tag: string, attributes: Record<string, Attribute> | null = null, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") node.addEventListener(name.slice(2).toLowerCase(), value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  append(node, children);
  return node;
}

/**
 * An element whose children are `html`, read as markup.
 *
 * It is for markup the page wrote itself, as it does to render a body. What a file holds goes
 * through `h`, which shows it as text.
 */
export function markup(tag: string, attributes: Record<string, Attribute> | null, html: string): HTMLElement {
  const node = h(tag, attributes);
  node.innerHTML = html;
  return node;
}

function append(node: HTMLElement, child: Child): void {
  if (child === false || child === undefined) return;
  if (typeof child === "string" || child instanceof Node) node.append(child);
  else for (const each of child) append(node, each);
}

export const mono = (text: string, className = "") => h("span", { class: `mono ${className}`.trimEnd() }, text);

export const muted = (text: string) => h("span", { class: "muted" }, text);
