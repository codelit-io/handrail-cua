import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname } from "node:path";

export interface LegacyTargetOptions {
  host?: string;
  port?: number;
}

export interface LegacyTargetHandle {
  host: string;
  port: number;
  origin: string;
  entryUrl: (scenario?: LegacyScenario, extra?: Record<string, string>) => string;
  close: () => Promise<void>;
}

export type LegacyScenario =
  | "normal"
  | "notice"
  | "slow"
  | "session-expired"
  | "ambiguous"
  | "off-origin";

const assets = {
  "/legacy": { file: "shell.html", contentType: "text/html; charset=utf-8" },
  "/legacy/": { file: "shell.html", contentType: "text/html; charset=utf-8" },
  "/legacy/workspace": { file: "workspace.html", contentType: "text/html; charset=utf-8" },
  "/legacy/legacy.css": { file: "legacy.css", contentType: "text/css; charset=utf-8" },
  "/legacy/legacy.js": { file: "legacy.js", contentType: "text/javascript; charset=utf-8" },
} as const;

const assetCache = new Map<string, Buffer>();

async function loadAsset(file: string): Promise<Buffer> {
  const cached = assetCache.get(file);
  if (cached) return cached;

  const data = await readFile(new URL(`./assets/${file}`, import.meta.url));
  assetCache.set(file, data);
  return data;
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Legacy target did not expose a TCP address."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function startLegacyTarget(
  options: LegacyTargetOptions = {},
): Promise<LegacyTargetHandle> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);

      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Frame-Options", "SAMEORIGIN");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'self'",
      );

      if (requestUrl.pathname === "/health") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ status: "ok", target: "handrail-synthetic-legacy" }));
        return;
      }

      const asset = assets[requestUrl.pathname as keyof typeof assets];
      if (!asset) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const body = await loadAsset(asset.file);
      response.writeHead(200, {
        "Content-Type": asset.contentType,
        "Content-Length": String(body.byteLength),
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          status: "error",
          message: error instanceof Error ? error.message : "Unknown target server error",
        }),
      );
    }
  });

  const port = await listen(server, host, options.port ?? 0);
  const origin = `http://${host}:${port}`;

  return {
    host,
    port,
    origin,
    entryUrl: (scenario = "normal", extra = {}) => {
      const url = new URL("/legacy", origin);
      if (scenario !== "normal") url.searchParams.set("scenario", scenario);
      for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
      return url.toString();
    },
    close: async () => closeServer(server),
  };
}

export function contentTypeFor(pathname: string): string {
  switch (extname(pathname)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
