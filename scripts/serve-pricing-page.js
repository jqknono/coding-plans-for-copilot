#!/usr/bin/env node

"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const PAGES_DIR = path.resolve(__dirname, "..", "pages");
const PRICING_JSON = path.resolve(__dirname, "..", "assets", "provider-pricing.json");
const METRICS_JSON = path.resolve(__dirname, "..", "assets", "openrouter-provider-metrics.json");
const OPENROUTER_PROVIDER_PLANS_JSON = path.resolve(__dirname, "..", "assets", "openrouter-provider-plans.json");
const PORT = Number.parseInt(process.env.PORT || "4173", 10);
const HOST = process.env.HOST || "127.0.0.1";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function sendFile(res, filePath, statusCode = 200) {
  const data = await fs.readFile(filePath);
  res.writeHead(statusCode, {
    "Content-Type": getMimeType(filePath),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function resolvePagesFilePath(requestPath) {
  const normalized = path.normalize(path.join(PAGES_DIR, requestPath));
  if (!normalized.startsWith(PAGES_DIR)) {
    return null;
  }
  return normalized;
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === "/provider-pricing.json") {
      return await sendFile(res, PRICING_JSON);
    }
    if (pathname === "/openrouter-provider-metrics.json") {
      return await sendFile(res, METRICS_JSON);
    }
    if (pathname === "/openrouter-provider-plans.json") {
      return await sendFile(res, OPENROUTER_PROVIDER_PLANS_JSON);
    }

    const requestedPath = pathname === "/" ? "/index.html" : pathname;
    const filePath = resolvePagesFilePath(requestedPath);
    if (!filePath) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    await sendFile(res, filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
    console.error("[serve:page] request error:", error && error.message ? error.message : error);
  }
}

async function ensureFilesReady() {
  await fs.access(path.join(PAGES_DIR, "index.html"));
  await fs.access(PRICING_JSON);
  await fs.access(METRICS_JSON);
  await fs.access(OPENROUTER_PROVIDER_PLANS_JSON);
}

async function main() {
  await ensureFilesReady();

  const server = http.createServer((req, res) => {
    handleRequest(req, res);
  });

  server.listen(PORT, HOST, () => {
    console.log(`[serve:page] http://${HOST}:${PORT}`);
  });
}

main().catch((error) => {
  console.error("[serve:page] startup failed:", error && error.message ? error.message : error);
  process.exit(1);
});

