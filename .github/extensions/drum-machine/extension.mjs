// Extension: drum-machine
// An FM-synthesis drum machine canvas. The renderer (ui.html) is a self-contained
// Web Audio app that generates every drum sound live via frequency modulation —
// no samples. This entry point just serves the renderer and persists the
// pattern/voice state to a JSON artifact so kits survive reloads.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_PATH = join(__dirname, "ui.html");

// State is keyed by the logical "kit" id (from open input, default "default")
// so the same kit shows the same content regardless of instanceId.
const STORE_DIR = join(__dirname, "artifacts");
function stateFile(kitId) {
  const safe = String(kitId).replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(STORE_DIR, `kit-${safe}.json`);
}

// instanceId -> { server, url, kitId }
const servers = new Map();

async function readKit(kitId) {
  try {
    return await readFile(stateFile(kitId), "utf8");
  } catch {
    return null;
  }
}
async function writeKit(kitId, json) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(stateFile(kitId), json, "utf8");
}

async function startServer(instanceId, kitId, log) {
  const html = await readFile(UI_PATH, "utf8");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }
      if (url.pathname === "/state") {
        if (req.method === "GET") {
          const data = await readKit(kitId);
          res.setHeader("Content-Type", "application/json");
          res.end(data ?? "null");
          return;
        }
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
          req.on("end", async () => {
            try { await writeKit(kitId, body); res.statusCode = 204; res.end(); }
            catch (e) { res.statusCode = 500; res.end(String(e)); }
          });
          return;
        }
      }
      res.statusCode = 404;
      res.end("not found");
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
      log?.(`request error: ${e}`, { level: "error" });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/`, kitId };
}

const session = await joinSession({
  canvases: [
    createCanvas({
      id: "drum-machine",
      displayName: "FM Drum Machine",
      description: "A frequency-modulation drum machine: build step sequences and sculpt each drum voice with live FM synthesis (no samples).",
      inputSchema: {
        type: "object",
        properties: {
          kitId: { type: "string", description: "Logical kit id; patterns/voices are saved per kit." },
        },
      },
      actions: [
        {
          name: "load_pattern",
          description: "Overwrite a kit's saved state with a full pattern/voice JSON payload (same shape the canvas persists).",
          inputSchema: {
            type: "object",
            properties: {
              kitId: { type: "string" },
              state: { type: "object", description: "Full machine state: { bpm, swing, master, selected, tracks:[...] }." },
            },
            required: ["state"],
          },
          handler: async (ctx) => {
            const kitId = ctx.input?.kitId || "default";
            await writeKit(kitId, JSON.stringify(ctx.input.state));
            return { ok: true, kitId };
          },
        },
        {
          name: "get_pattern",
          description: "Return the saved JSON state for a kit (or null if none saved yet).",
          inputSchema: {
            type: "object",
            properties: { kitId: { type: "string" } },
          },
          handler: async (ctx) => {
            const kitId = ctx.input?.kitId || "default";
            const data = await readKit(kitId);
            return { kitId, state: data ? JSON.parse(data) : null };
          },
        },
      ],
      open: async (ctx) => {
        const kitId = ctx.input?.kitId || "default";
        let entry = servers.get(ctx.instanceId);
        if (!entry || entry.kitId !== kitId) {
          if (entry) await new Promise((r) => entry.server.close(() => r()));
          entry = await startServer(ctx.instanceId, kitId, session?.log);
          servers.set(ctx.instanceId, entry);
        }
        return { title: "FM Drum Machine", status: kitId, url: entry.url };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          await new Promise((resolve) => entry.server.close(() => resolve()));
        }
      },
    }),
  ],
});
