import { Store } from "@estoc/store";
import { SqliteBackend } from "@estoc/store/sqlite";
import { serve } from "./node.ts";
import { Runtime } from "./runtime.ts";

const [database, pages, port = "0", ...rest] = process.argv.slice(2);
if (database === undefined || pages === undefined || rest.length > 0) {
  console.error("Usage: main.ts <database> <folder of the pages> [port]");
  process.exitCode = 1;
} else {
  const backend = new SqliteBackend(database, { isReadOnly: true });
  const server = await serve(new Runtime(new Store(backend)), pages, Number(port));
  const stop = async () => {
    await server.close();
    backend.close();
  };
  process.once("SIGTERM", stop).once("SIGINT", stop);
  // Whoever waits for this line can open the page from then on.
  console.log(`${database} is shown at ${server.origin}`);
}
