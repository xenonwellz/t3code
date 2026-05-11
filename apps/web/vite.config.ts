import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5733);
const host = process.env.HOST?.trim() || "localhost";
const configuredWsUrl = process.env.VITE_WS_URL?.trim();
const configuredHttpUrl = process.env.VITE_HTTP_URL?.trim();
const configuredHostedAppChannel = process.env.VITE_HOSTED_APP_CHANNEL?.trim() || "";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const configuredHostedAppUrl = (() => {
  const explicitHostedAppUrl = process.env.VITE_HOSTED_APP_URL?.trim();
  if (explicitHostedAppUrl) {
    return explicitHostedAppUrl;
  }
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return undefined;
})();
const sourcemapEnv = process.env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

function stripUrlToHttpOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Base URL for dev-only HTTP proxying (`/.well-known`, `/api`, …). */
function resolveDevProxyTarget(
  wsUrl: string | undefined,
  httpUrl: string | undefined,
): string | undefined {
  if (wsUrl) {
    const fromWs = stripUrlToHttpOrigin(wsUrl);
    if (fromWs) {
      return fromWs;
    }
  }
  if (httpUrl) {
    return stripUrlToHttpOrigin(httpUrl);
  }
  return undefined;
}

/**
 * Prefer `127.0.0.1` over `localhost` for the outbound proxy target so the dev
 * proxy does not depend on IPv6 `::1` resolution (which can hang or miss a
 * backend that is only listening on IPv4 loopback).
 */
function preferIpv4LoopbackDevProxyTarget(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
    }
    return url.toString();
  } catch {
    return origin;
  }
}

const devProxyTargetRaw = resolveDevProxyTarget(configuredWsUrl, configuredHttpUrl);
const devProxyTarget = devProxyTargetRaw
  ? preferIpv4LoopbackDevProxyTarget(devProxyTargetRaw)
  : undefined;

export default defineConfig({
  plugins: [
    tanstackRouter(),
    react(),
    babel({
      // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
      // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
      // whereas the previous version of the plugin parsed all files with a .ts extension.
      // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
  ],
  optimizeDeps: {
    include: [
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@pierre/diffs/worker/worker.js",
      "effect/Array",
      "effect/Order",
    ],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
    "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(configuredHostedAppUrl ?? ""),
    "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify(configuredHostedAppChannel),
    "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host,
    port,
    strictPort: true,
    ...(devProxyTarget
      ? {
          proxy: {
            "/.well-known": {
              target: devProxyTarget,
              changeOrigin: true,
            },
            "/api": {
              target: devProxyTarget,
              changeOrigin: true,
            },
            "/attachments": {
              target: devProxyTarget,
              changeOrigin: true,
            },
          },
        }
      : {}),
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
  },
});
