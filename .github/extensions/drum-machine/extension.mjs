// Extension: drum-machine
// An FM-synthesis drum machine canvas with an agent control surface.
//
// - ui.html is a self-contained Web Audio app: a step sequencer where every drum
//   sound is generated live via two-operator frequency modulation (no samples),
//   plus LFOs that route into the FM modulation.
// - This entry point serves the renderer, persists per-kit state, pushes live
//   updates to the open canvas over SSE, and exposes `drum_*` tools so the agent
//   can drive the machine from natural-language prompts.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_PATH = join(__dirname, "ui.html");
const STORE_DIR = join(__dirname, "artifacts");

function stateFile(kitId) {
  const safe = String(kitId).replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(STORE_DIR, `kit-${safe}.json`);
}

// ---------------- shared defaults (kept in sync with ui.html) ----------------
const STEPS = 16;
function trackDefs() {
  return [
    { name: "Kick",  color: "#f0883e", v: { carrier: 55,  ratio: 0.5, index: 8,   indexDecay: 0.04, pitchEnv: 280, pitchDecay: 0.06, ampDecay: 0.45, noise: 0,  noiseHP: 100,  gain: 95 } },
    { name: "Snare", color: "#f85149", v: { carrier: 190, ratio: 1.6, index: 120, indexDecay: 0.05, pitchEnv: 90,  pitchDecay: 0.03, ampDecay: 0.22, noise: 70, noiseHP: 1400, gain: 80 } },
    { name: "Clap",  color: "#db61a2", v: { carrier: 320, ratio: 2.1, index: 60,  indexDecay: 0.03, pitchEnv: 0,   pitchDecay: 0.02, ampDecay: 0.18, noise: 85, noiseHP: 1100, gain: 72 } },
    { name: "Tom",   color: "#a371f7", v: { carrier: 120, ratio: 1.0, index: 18,  indexDecay: 0.08, pitchEnv: 160, pitchDecay: 0.10, ampDecay: 0.40, noise: 0,  noiseHP: 200,  gain: 78 } },
    { name: "ClHat", color: "#2dd4bf", v: { carrier: 800, ratio: 4.7, index: 200, indexDecay: 0.02, pitchEnv: 0,   pitchDecay: 0.02, ampDecay: 0.06, noise: 60, noiseHP: 7000, gain: 60 } },
    { name: "OpHat", color: "#56d364", v: { carrier: 820, ratio: 4.7, index: 200, indexDecay: 0.05, pitchEnv: 0,   pitchDecay: 0.02, ampDecay: 0.35, noise: 55, noiseHP: 7000, gain: 58 } },
    { name: "Cow",   color: "#e3b341", v: { carrier: 540, ratio: 1.48,index: 40,  indexDecay: 0.2,  pitchEnv: 0,   pitchDecay: 0.02, ampDecay: 0.30, noise: 0,  noiseHP: 100,  gain: 64 } },
    { name: "Zap",   color: "#79c0ff", v: { carrier: 440, ratio: 3.3, index: 600, indexDecay: 0.15, pitchEnv: 600, pitchDecay: 0.20, ampDecay: 0.30, noise: 0,  noiseHP: 100,  gain: 66 } },
  ];
}
function defaultLFOs() {
  return [
    { on: false, track: "All", param: "index",   wave: "sine",     rate: 0.5, depth: 0 },
    { on: false, track: "All", param: "noiseHP", wave: "triangle", rate: 2,   depth: 0 },
    { on: false, track: "All", param: "pitch",   wave: "sine",     rate: 4,   depth: 0 },
  ];
}
function blankSteps() { return new Array(STEPS).fill(false); }
function freshState() {
  return {
    bpm: 120, swing: 0, master: 80, selected: 0,
    tracks: trackDefs().map(t => ({ ...t, v: { ...t.v }, steps: blankSteps(), mute: false })),
    lfos: defaultLFOs(),
  };
}

const VOICE_RANGES = {
  carrier: [20, 2000], ratio: [0.1, 12], index: [0, 1500], indexDecay: [0.005, 1.2],
  pitchEnv: [0, 2000], pitchDecay: [0.005, 1.0], ampDecay: [0.01, 2.0],
  noise: [0, 100], noiseHP: [100, 12000], gain: [0, 100],
};
const LFO_PARAMS = ["index", "pitch", "ratio", "noiseHP", "gain"];
const LFO_WAVES = ["sine", "triangle", "square", "sawtooth", "random"];
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const TRACK_ALIASES = {
  kick: "Kick", bd: "Kick", bassdrum: "Kick", kik: "Kick",
  snare: "Snare", sd: "Snare", sn: "Snare",
  clap: "Clap", cp: "Clap", handclap: "Clap",
  tom: "Tom", lowtom: "Tom",
  clhat: "ClHat", hat: "ClHat", hh: "ClHat", hihat: "ClHat", closedhat: "ClHat", ch: "ClHat",
  ophat: "OpHat", oh: "OpHat", openhat: "OpHat", open: "OpHat",
  cow: "Cow", cowbell: "Cow",
  zap: "Zap", fx: "Zap", blip: "Zap", perc: "Zap",
};
function resolveTrack(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().replace(/[^a-z]/g, "");
  const names = trackDefs().map(t => t.name);
  const exact = names.find(n => n.toLowerCase() === key);
  if (exact) return exact;
  return TRACK_ALIASES[key] || null;
}

// ---------------- persistence + live push ----------------
const sseClients = new Map();   // kitId -> Set(res)
let lastOpenedKit = "default";

async function readKit(kitId) {
  try { return JSON.parse(await readFile(stateFile(kitId), "utf8")); }
  catch { return null; }
}
async function getState(kitId) {
  return (await readKit(kitId)) || freshState();
}
async function writeKit(kitId, stateObj) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(stateFile(kitId), JSON.stringify(stateObj), "utf8");
}
function broadcast(kitId, msg) {
  const set = sseClients.get(kitId);
  if (!set) return;
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of set) { try { res.write(payload); } catch {} }
}
async function pushState(kitId, stateObj) {
  await writeKit(kitId, stateObj);
  broadcast(kitId, { type: "state", state: stateObj });
}

// ---------------- style generator ----------------
function setPattern(state, trackName, indices) {
  const t = state.tracks.find(x => x.name === trackName);
  if (!t) return;
  t.steps = blankSteps();
  indices.forEach(i => { if (i >= 0 && i < STEPS) t.steps[i] = true; });
}
function setVoice(state, trackName, params) {
  const t = state.tracks.find(x => x.name === trackName);
  if (!t) return;
  for (const [k, val] of Object.entries(params)) {
    if (VOICE_RANGES[k]) t.v[k] = clamp(+val, VOICE_RANGES[k][0], VOICE_RANGES[k][1]);
  }
}
function setLFO(state, slot, cfg) {
  const i = clamp((slot | 0) - 1, 0, 2);
  const lfo = state.lfos[i];
  if (cfg.on !== undefined) lfo.on = !!cfg.on;
  if (cfg.track !== undefined) lfo.track = cfg.track === "All" ? "All" : (resolveTrack(cfg.track) || "All");
  if (cfg.param !== undefined && LFO_PARAMS.includes(cfg.param)) lfo.param = cfg.param;
  if (cfg.wave !== undefined && LFO_WAVES.includes(cfg.wave)) lfo.wave = cfg.wave;
  if (cfg.rate !== undefined) lfo.rate = clamp(+cfg.rate, 0.02, 20);
  if (cfg.depth !== undefined) lfo.depth = Math.max(0, +cfg.depth);
}

// Named style presets. The agent can call this for a quick foundation and then
// refine with the granular tools.
function generateStyle(styleRaw, bpmOverride) {
  const style = String(styleRaw || "").toLowerCase();
  const s = freshState();
  const has = (...words) => words.some(w => style.includes(w));

  if (has("liquid", "photek", "dnb", "drum and bass", "drum'n'bass", "jungle")) {
    s.bpm = bpmOverride || 172; s.swing = 8;
    setPattern(s, "Kick",  [0, 10]);
    setPattern(s, "Snare", [4, 12]);
    setPattern(s, "ClHat", [2, 3, 6, 8, 11, 14, 15]);
    setPattern(s, "OpHat", [6]);
    setPattern(s, "Tom",   [9]);
    // deep sub kick
    setVoice(s, "Kick",  { carrier: 48, ratio: 0.5, index: 6, pitchEnv: 200, pitchDecay: 0.08, ampDecay: 0.5, gain: 95 });
    // crisp, slightly pitched snare with airy noise
    setVoice(s, "Snare", { carrier: 210, ratio: 1.7, index: 90, indexDecay: 0.06, noise: 72, noiseHP: 1800, ampDecay: 0.2, gain: 82 });
    // tight jazzy hats
    setVoice(s, "ClHat", { carrier: 900, ratio: 5.1, index: 230, indexDecay: 0.015, noise: 55, noiseHP: 8000, ampDecay: 0.05, gain: 52 });
    setVoice(s, "OpHat", { carrier: 900, ratio: 5.1, index: 230, indexDecay: 0.05, noise: 50, noiseHP: 8000, ampDecay: 0.28, gain: 50 });
    setVoice(s, "Tom",   { carrier: 150, ratio: 1.0, index: 22, pitchEnv: 180, pitchDecay: 0.12, ampDecay: 0.35, gain: 70 });
    // liquid movement: slow shimmer on snare FM index + random hat tone
    setLFO(s, 1, { on: true, track: "Snare", param: "index",   wave: "sine",   rate: 0.35, depth: 70 });
    setLFO(s, 2, { on: true, track: "ClHat", param: "noiseHP", wave: "random", rate: 6,    depth: 2500 });
    setLFO(s, 3, { on: false });
    s.selected = 1;
    return { state: s, summary: "Liquid/Photek DnB: 172 BPM rolling two-step, deep sub kick, crisp pitched snare, jazzy tight hats, with a slow FM-index shimmer on the snare and a random S&H tone wobble on the hats." };
  }

  if (has("techno")) {
    s.bpm = bpmOverride || 130;
    setPattern(s, "Kick",  [0, 4, 8, 12]);
    setPattern(s, "ClHat", [2, 6, 10, 14]);
    setPattern(s, "OpHat", [2, 6, 10, 14]);
    setPattern(s, "Clap",  [4, 12]);
    setPattern(s, "Zap",   [7, 15]);
    setLFO(s, 1, { on: true, track: "Zap", param: "pitch", wave: "sawtooth", rate: 3, depth: 200 });
    s.selected = 0;
    return { state: s, summary: "Driving techno: four-on-the-floor, offbeat hats, clap backbeat, acid-ish Zap with a sawtooth pitch LFO." };
  }

  if (has("house", "four on the floor", "fourfloor", "disco")) {
    s.bpm = bpmOverride || 124;
    setPattern(s, "Kick",  [0, 4, 8, 12]);
    setPattern(s, "ClHat", [2, 6, 10, 14]);
    setPattern(s, "OpHat", [2, 6, 10, 14]);
    setPattern(s, "Clap",  [4, 12]);
    s.selected = 0;
    return { state: s, summary: "Classic house: four-on-the-floor kick, offbeat open hats, clap on 2 and 4." };
  }

  if (has("boom", "hip hop", "hiphop", "boombap")) {
    s.bpm = bpmOverride || 90; s.swing = 22;
    setPattern(s, "Kick",  [0, 10]);
    setPattern(s, "Snare", [4, 12]);
    setPattern(s, "ClHat", [0, 2, 4, 6, 8, 10, 12, 14]);
    setPattern(s, "OpHat", [14]);
    setVoice(s, "Kick", { carrier: 60, ampDecay: 0.5, gain: 96 });
    setVoice(s, "Snare", { noise: 78, noiseHP: 1500, ampDecay: 0.24 });
    s.selected = 1;
    return { state: s, summary: "Boom bap: swung 90 BPM, dusty kick, fat snare on the backbeat, steady 8th-note hats." };
  }

  if (has("break", "breakbeat", "amen")) {
    s.bpm = bpmOverride || 140;
    setPattern(s, "Kick",  [0, 6, 9]);
    setPattern(s, "Snare", [4, 12]);
    setPattern(s, "ClHat", [2, 5, 8, 11, 14]);
    s.selected = 1;
    return { state: s, summary: "Breakbeat: syncopated kick, snare on the backbeat, broken hat pattern." };
  }

  // default / unknown: a tasteful starter the agent can refine
  s.bpm = bpmOverride || 120;
  setPattern(s, "Kick",  [0, 4, 8, 12]);
  setPattern(s, "ClHat", [2, 6, 10, 14]);
  setPattern(s, "Snare", [4, 12]);
  s.selected = 0;
  return { state: s, summary: `No specific preset matched "${styleRaw}", so I laid down a clean backbeat foundation. Refine it with drum_set_pattern / drum_set_voice / drum_set_lfo.` };
}

// ---------------- HTTP server (per open instance) ----------------
async function startServer(instanceId, kitId, log) {
  const html = await readFile(UI_PATH, "utf8");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html); return;
      }
      if (url.pathname === "/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        res.write(": connected\n\n");
        if (!sseClients.has(kitId)) sseClients.set(kitId, new Set());
        sseClients.get(kitId).add(res);
        res.on("close", () => { sseClients.get(kitId)?.delete(res); });
        return;
      }
      if (url.pathname === "/state") {
        if (req.method === "GET") {
          const data = await readKit(kitId);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data)); return;
        }
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
          req.on("end", async () => {
            try { await writeKit(kitId, JSON.parse(body)); res.statusCode = 204; res.end(); }
            catch (e) { res.statusCode = 400; res.end(String(e)); }
          });
          return;
        }
      }
      res.statusCode = 404; res.end("not found");
    } catch (e) {
      res.statusCode = 500; res.end(String(e));
      log?.(`request error: ${e}`, { level: "error" });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/`, kitId };
}

const servers = new Map();  // instanceId -> { server, url, kitId }

// ---------------- tool helpers ----------------
function ok(summary, state) { return JSON.stringify({ ok: true, summary, state }); }
function err(message) { return JSON.stringify({ ok: false, error: message }); }
function kitOf(args) { return args?.kitId || lastOpenedKit || "default"; }

// ---------------- session ----------------
const session = await joinSession({
  tools: [
    {
      name: "drum_get_state",
      description: "Get the FM drum machine's current state (tempo, swing, per-track 16-step patterns, FM voice params, and LFOs).",
      parameters: { type: "object", properties: { kitId: { type: "string", description: "Kit id (defaults to the open kit)." } } },
      handler: async (args) => {
        const state = await getState(kitOf(args));
        return JSON.stringify({ ok: true, kitId: kitOf(args), state });
      },
    },
    {
      name: "drum_set_tempo",
      description: "Set the tempo (BPM 40-300) and/or swing (0-60%) of the drum machine.",
      parameters: { type: "object", properties: {
        bpm: { type: "number" }, swing: { type: "number" }, kitId: { type: "string" },
      } },
      handler: async (args) => {
        const kit = kitOf(args); const state = await getState(kit);
        if (args.bpm !== undefined) state.bpm = clamp(+args.bpm, 40, 300);
        if (args.swing !== undefined) state.swing = clamp(+args.swing, 0, 60);
        await pushState(kit, state);
        return ok(`Tempo ${state.bpm} BPM, swing ${state.swing}%.`);
      },
    },
    {
      name: "drum_set_pattern",
      description: "Set the 16-step pattern for one track. Provide `steps` as the list of step indices (0-15) to turn ON. Set additive=true to add to the existing pattern instead of replacing it.",
      parameters: { type: "object", properties: {
        track: { type: "string", description: "Track name or alias (kick, snare, clap, tom, hat/clhat, ophat, cow, zap)." },
        steps: { type: "array", items: { type: "number" }, description: "Step indices 0-15 to enable." },
        additive: { type: "boolean" },
        kitId: { type: "string" },
      }, required: ["track", "steps"] },
      handler: async (args) => {
        const kit = kitOf(args); const state = await getState(kit);
        const name = resolveTrack(args.track);
        if (!name) return err(`Unknown track "${args.track}". Valid: ${trackDefs().map(t => t.name).join(", ")}.`);
        const t = state.tracks.find(x => x.name === name);
        if (!args.additive) t.steps = blankSteps();
        (args.steps || []).forEach(i => { const n = i | 0; if (n >= 0 && n < STEPS) t.steps[n] = true; });
        await pushState(kit, state);
        return ok(`${name}: ${t.steps.map((on,i)=>on?i:null).filter(x=>x!==null).join(", ") || "(empty)"}.`);
      },
    },
    {
      name: "drum_set_voice",
      description: "Set FM voice parameters for a track. Params: carrier (Hz), ratio (modulator ratio), index (FM depth), indexDecay (s), pitchEnv (Hz drop), pitchDecay (s), ampDecay (s), noise (0-100%), noiseHP (Hz), gain (0-100).",
      parameters: { type: "object", properties: {
        track: { type: "string" },
        carrier: { type: "number" }, ratio: { type: "number" }, index: { type: "number" },
        indexDecay: { type: "number" }, pitchEnv: { type: "number" }, pitchDecay: { type: "number" },
        ampDecay: { type: "number" }, noise: { type: "number" }, noiseHP: { type: "number" }, gain: { type: "number" },
        kitId: { type: "string" },
      }, required: ["track"] },
      handler: async (args) => {
        const kit = kitOf(args); const state = await getState(kit);
        const name = resolveTrack(args.track);
        if (!name) return err(`Unknown track "${args.track}".`);
        const params = {};
        for (const k of Object.keys(VOICE_RANGES)) if (args[k] !== undefined) params[k] = args[k];
        setVoice(state, name, params);
        await pushState(kit, state);
        const t = state.tracks.find(x => x.name === name);
        return ok(`${name} voice updated: ${Object.keys(params).map(k => `${k}=${t.v[k]}`).join(", ") || "(no changes)"}.`);
      },
    },
    {
      name: "drum_set_lfo",
      description: "Configure one of the 3 LFOs that route into the FM modulation. target param is one of: index, pitch, ratio, noiseHP, gain. wave is sine/triangle/square/sawtooth/random. depth is in the target param's units. track is a track name or 'All'.",
      parameters: { type: "object", properties: {
        slot: { type: "number", description: "LFO slot 1-3." },
        on: { type: "boolean" },
        track: { type: "string", description: "Track name or 'All'." },
        param: { type: "string", enum: LFO_PARAMS },
        wave: { type: "string", enum: LFO_WAVES },
        rate: { type: "number", description: "LFO rate in Hz (0.02-20)." },
        depth: { type: "number", description: "Modulation depth in the target param's units." },
        kitId: { type: "string" },
      }, required: ["slot"] },
      handler: async (args) => {
        const kit = kitOf(args); const state = await getState(kit);
        setLFO(state, args.slot, args);
        await pushState(kit, state);
        const l = state.lfos[clamp((args.slot|0)-1,0,2)];
        return ok(`LFO ${args.slot}: ${l.on?"ON":"off"} ${l.wave} @ ${l.rate}Hz -> ${l.track}.${l.param} depth ${l.depth}.`);
      },
    },
    {
      name: "drum_clear",
      description: "Clear all steps on every track (keeps tempo and voice settings).",
      parameters: { type: "object", properties: { kitId: { type: "string" } } },
      handler: async (args) => {
        const kit = kitOf(args); const state = await getState(kit);
        state.tracks.forEach(t => t.steps = blankSteps());
        await pushState(kit, state);
        return ok("Cleared all patterns.");
      },
    },
    {
      name: "drum_transport",
      description: "Start or stop playback of the drum machine. action: 'play' or 'stop'.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["play", "stop"] }, kitId: { type: "string" },
      }, required: ["action"] },
      handler: async (args) => {
        const kit = kitOf(args);
        broadcast(kit, { type: "transport", action: args.action === "stop" ? "stop" : "play" });
        return ok(`Transport: ${args.action}.`);
      },
    },
    {
      name: "drum_generate",
      description: "Generate a complete beat for a named style and load it into the machine. Understands: liquid/photek drum'n'bass, techno, house, boom bap / hip hop, breakbeat. Composes pattern, FM voices, and LFOs. After generating, call drum_transport play to hear it.",
      parameters: { type: "object", properties: {
        style: { type: "string", description: "Style description, e.g. 'photek-inspired liquid drum and bass'." },
        bpm: { type: "number", description: "Optional BPM override." },
        kitId: { type: "string" },
      }, required: ["style"] },
      handler: async (args) => {
        const kit = kitOf(args);
        const { state, summary } = generateStyle(args.style, args.bpm);
        await pushState(kit, state);
        return ok(summary, state);
      },
    },
  ],
  canvases: [
    createCanvas({
      id: "drum-machine",
      displayName: "FM Drum Machine",
      description: "A frequency-modulation drum machine: build step sequences, sculpt each drum voice with live FM synthesis (no samples), route LFOs into the modulation, and drive it all from prompts via drum_* tools.",
      inputSchema: { type: "object", properties: { kitId: { type: "string", description: "Logical kit id; patterns/voices/LFOs are saved per kit." } } },
      actions: [
        {
          name: "load_pattern",
          description: "Overwrite a kit's saved state with a full state JSON payload (same shape the canvas persists).",
          inputSchema: { type: "object", properties: { kitId: { type: "string" }, state: { type: "object" } }, required: ["state"] },
          handler: async (ctx) => { const kit = ctx.input?.kitId || lastOpenedKit; await pushState(kit, ctx.input.state); return { ok: true, kitId: kit }; },
        },
        {
          name: "get_pattern",
          description: "Return the saved JSON state for a kit (or null).",
          inputSchema: { type: "object", properties: { kitId: { type: "string" } } },
          handler: async (ctx) => { const kit = ctx.input?.kitId || lastOpenedKit; return { kitId: kit, state: await readKit(kit) }; },
        },
      ],
      open: async (ctx) => {
        const kitId = ctx.input?.kitId || "default";
        lastOpenedKit = kitId;
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
        if (entry) { servers.delete(ctx.instanceId); await new Promise((resolve) => entry.server.close(() => resolve())); }
      },
    }),
  ],
});
