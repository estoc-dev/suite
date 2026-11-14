import { latestOnly } from "./latest.ts";
import { type Page, pageOf, readFile } from "./page.ts";
import { pageView } from "./page-view.ts";

const app = document.querySelector("#app") as HTMLElement;

let fileTask: ReturnType<typeof readFile> | undefined;

const drawLatest = latestOnly(draw);

const show = () => void drawLatest(pageOf(fileTask, location.hash));

// The links of one file are mostly absent from the next, so a file opens at its root.
function open(file: File): void {
  fileTask = readFile(file);
  history.replaceState(null, "", location.pathname + location.search);
  show();
}

function draw(page: Page): void {
  app.replaceChildren(...pageView(page, open));
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
