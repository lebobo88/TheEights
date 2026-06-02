import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";

// Atlas web UI. Dev server is loopback-only; /api is proxied to the
// read-only MCP bridge (also loopback-only). No non-loopback exposure.
//
// Discover the bridge's ACTUAL port: explicit env wins; else the
// `.atlas-bridge-port` file the bridge writes on startup (it may have rolled
// forward off 8788 if that was busy); else the 8788 default.
function bridgePort(): number {
  if (process.env.EIGHTS_ATLAS_BRIDGE_PORT) return Number(process.env.EIGHTS_ATLAS_BRIDGE_PORT);
  try {
    const f = new URL(".atlas-bridge-port", import.meta.url);
    if (existsSync(f)) return Number(readFileSync(f, "utf8").trim()) || 8788;
  } catch {
    /* ignore */
  }
  return 8788;
}
const BRIDGE_PORT = bridgePort();

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.EIGHTS_ATLAS_DEV_PORT ?? 5174),
    // Preflight: roll forward to the next free port instead of crashing on
    // EADDRINUSE when 5174 is already taken by another dev server.
    strictPort: false,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${BRIDGE_PORT}`,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: Number(process.env.EIGHTS_ATLAS_PREVIEW_PORT ?? 5174),
    strictPort: false,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
