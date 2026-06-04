import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";

// Plugin order matters: tsConfigPaths resolves the "@/*" alias from tsconfig,
// and viteReact MUST come after tanstackStart.
export default defineConfig({
  // Dev only: proxy the terminal gateway so the browser uses one same-origin host
  // (keeps the auth cookie same-origin). Mirrors the prod reverse-proxy topology.
  // Override the gateway address with GATEWAY_PORT if you changed it.
  server: {
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8081", ws: true },
      "/auth": { target: "http://127.0.0.1:8081" },
    },
  },
  plugins: [
    tsConfigPaths(),
    tailwindcss(),
    tanstackStart({
      // Route TanStack Start's server entry to src/server.ts (our SSR error wrapper).
      server: { entry: "./src/server.ts" },
    }),
    // Nitro builds a self-hosted Node server at .output/server/index.mjs
    // (run with `node .output/server/index.mjs`; honors PORT, default 3000).
    nitro(),
    viteReact(),
  ],
});
