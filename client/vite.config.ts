import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { readFileSync } from "fs";

const host = process.env.TAURI_DEV_HOST;
const instance = parseInt(process.env.WIRED_INSTANCE || "0", 10);
const port = parseInt(process.env.WIRED_PORT || String(1420 + instance * 2), 10);

const tauriConf = JSON.parse(
  readFileSync(path.resolve(__dirname, "src-tauri/tauri.conf.json"), "utf-8"),
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(tauriConf.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Vite 8's default floor is Safari 16.4; the Tauri bundle still installs
    // on macOS 13.0, whose WKWebView is Safari 16.0. Keep the Vite 7 defaults.
    target: ["chrome107", "edge107", "firefox104", "safari16"],
    sourcemap: false,
    rolldownOptions: {
      output: {
        // What the app needs before it can draw the shell. Left alone, Rolldown
        // cuts that code into well over a hundred startup chunks (every module
        // shared with a lazy route becomes its own file, down to single icons).
        // These groups fold it into a handful, split by how often each part
        // changes so a release only invalidates the app code:
        //   react   - React, the router and react-redux: changes on an upgrade
        //   nostr   - nostr-tools and the noble/scure crypto under it: same
        //   vendor  - every other library the shell needs
        //   shell   - our own startup code (store, relay layer, landing view)
        // `$initial` limits each group to modules the entry reaches by static
        // import, so nothing lazy (hls.js, livekit, the editors) is pulled in.
        codeSplitting: {
          groups: [
            {
              name: "react",
              tags: ["$initial"],
              test: /node_modules[\\/](?:react|react-dom|scheduler|react-redux|react-router|react-router-dom|use-sync-external-store)[\\/]/,
              priority: 40,
            },
            {
              name: "nostr",
              tags: ["$initial"],
              test: /node_modules[\\/](?:nostr-tools|@noble|@scure)[\\/]/,
              priority: 30,
            },
            {
              name: "vendor",
              tags: ["$initial"],
              test: /node_modules[\\/]/,
              priority: 20,
            },
            {
              name: "shell",
              tags: ["$initial"],
              priority: 10,
            },
          ],
        },
      },
    },
    minify: 'terser',
    terserOptions: {
      compress: {
        // Strip noisy logs but keep warn/error so production issues stay diagnosable.
        pure_funcs: ['console.log', 'console.debug', 'console.info'],
        drop_debugger: true,
      },
    },
  },
  clearScreen: false,
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
