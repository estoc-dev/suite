import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";

// The port that main.ts of @estoc/explorer is started with while the pages are served from here.
const runtimeOrigin = "http://127.0.0.1:4750";
const port = 4751;

export default defineConfig({
  plugins: [solid()],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {
      "/channel": {
        target: runtimeOrigin,
        ws: true,
        // The runtime takes a WebSocket from a page of its own origin alone, and a page served from
        // here is of this origin. So the origin is changed to the runtime's for a page of this
        // origin and left as it came for any other, which the runtime then refuses as it would
        // without this server between them.
        configure: (proxy) =>
          proxy.on("proxyReqWs", (outgoing, incoming) => {
            if (incoming.headers.origin === `http://127.0.0.1:${port}`) outgoing.setHeader("origin", runtimeOrigin);
          }),
      },
    },
  },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
