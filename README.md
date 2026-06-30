# FM Drum Machine — Copilot canvas extension

A GitHub Copilot **canvas extension** that adds a step-sequencer drum machine to the
Copilot side panel. Every sound is generated live with **two-operator frequency
modulation** (Web Audio) — there are no samples anywhere. You can program it by hand,
route **LFOs** into the modulation, or just **ask the agent** for a beat.

![synthesis FM](https://img.shields.io/badge/synthesis-FM-blue) ![no samples](https://img.shields.io/badge/samples-none-success) ![agent controllable](https://img.shields.io/badge/agent-controllable-8957e5)

![FM Drum Machine running](media/demo.gif)

> A Photek-inspired liquid drum'n'bass pattern at 172 BPM. The highlighted column is the
> playhead stepping through 16th notes; every voice is synthesized live via FM, and two
> LFOs are wobbling the noise tone of the snare and hats for that liquid shimmer.

![FM Drum Machine interface](media/screenshot.png)

## What it does

- **16-step sequencer** across 8 drum voices (Kick, Snare, Clap, Tom, Closed/Open
  Hat, Cowbell, Zap). Click cells to program a pattern.
- **Live FM synth engine** — each voice is a carrier oscillator modulated by a second
  oscillator, with independent pitch, modulation-index, and amplitude envelopes.
- **Per-voice sound design** — select a track and sculpt 10 parameters: carrier
  frequency, mod ratio, FM index, mod decay, pitch drop & decay, amp decay, noise mix,
  noise tone, and level.
- **LFOs** — three low-frequency oscillators you can route into any voice's modulation
  (see below).
- **Agent control** — drive the whole machine from natural-language prompts via a set
  of `drum_*` tools, including style-aware beat generation.
- **Transport** — play/stop, BPM (40–300), swing, master volume.
- **Persistent kits** — patterns, voices, and LFOs are saved per `kitId` to a JSON
  artifact, so your work survives reloads. Live changes from the agent stream into the
  open canvas over Server-Sent Events.

Sounds are only produced by the sequencer — clicking cells or dragging sliders never
auditions on its own. Use the explicit **🔊 Audition** button to preview a voice.

## How the synthesis works

Each hit calls `playVoice()`, which builds this graph:

```
modulator osc ──▶ modGain (index envelope, Hz of deviation)
                      │
                      ▼
carrier osc.frequency  (sine, pitch envelope: startFreq → base)
   │
   ▼
amp gain (exp attack/decay) ──▶ master ──▶ destination

(optional)  noise buffer ──▶ highpass ──▶ noise gain ──▶ master
```

- The **modulator** runs at `carrier × ratio`. Its output is scaled by `modGain`,
  whose value is the instantaneous **frequency deviation in Hz** and decays over
  `indexDecay` — that envelope is what gives kicks their click and hats their metallic
  sheen.
- The **carrier** sweeps from `carrier + pitchEnv` down to `carrier` over `pitchDecay`
  for punch.
- A filtered **noise** layer is mixed in for snares, claps, and hats.

The sequencer uses a Web Audio **lookahead scheduler** (schedules ~100 ms ahead on a
25 ms timer) for tight, drift-free timing independent of the JS event loop.

## LFOs

Three independent LFOs can each be routed into a target on one track (or **All**
tracks). They are free-running master oscillators; when a note fires, the matching LFOs
are connected to that voice's live `AudioParam`s, so the modulation is continuous across
hits rather than retriggered per step.

Each LFO has:

- **Track** — which voice it affects (`All`, or a single track).
- **Target** — `index` (FM depth), `pitch` (carrier Hz), `ratio` (modulator ratio),
  `noiseHP` (noise high-pass Hz), or `gain`.
- **Wave** — `sine`, `triangle`, `square`, `sawtooth`, or `random` (sample & hold).
- **Rate** — 0.02–20 Hz.
- **Depth** — in the target parameter's own units (e.g. Hz for pitch, ± index for index).

## Agent control

The extension contributes `drum_*` agent tools, so you can talk to the machine in
natural language — for example:

> *"Give me a Photek-inspired liquid drum'n'bass beat."*
> *"Put a sine LFO on the snare's FM index, slow, and start playing."*

| Tool | Purpose |
| --- | --- |
| `drum_generate` | Generate a complete beat for a named style and load it. Understands liquid/photek drum'n'bass, techno, house, boom bap / hip hop, and breakbeat — composing pattern, FM voices, and LFOs. |
| `drum_get_state` | Return the current state (tempo, swing, patterns, voices, LFOs). |
| `drum_set_tempo` | Set BPM (40–300) and/or swing (0–60%). |
| `drum_set_pattern` | Set or add the 16-step pattern for one track. |
| `drum_set_voice` | Set FM voice parameters for a track. |
| `drum_set_lfo` | Configure one of the 3 LFOs (slot, track, target, wave, rate, depth, on/off). |
| `drum_clear` | Clear all steps (keeps tempo and voices). |
| `drum_transport` | Start or stop playback. |

Tracks accept friendly aliases (e.g. `kick`/`bd`, `snare`/`sd`, `hat`/`hh`, `oh`).

The canvas also exposes two host/SDK-callable actions used for state sync:

| Action | Purpose |
| --- | --- |
| `load_pattern` | Overwrite a kit's saved state with a full JSON payload (streamed live to the canvas). |
| `get_pattern`  | Return a kit's saved JSON state (or `null`). |

## Install

This repo lays the extension out at `.github/extensions/drum-machine/`, so any Copilot
project using this repo picks it up automatically. To use it elsewhere, copy that
folder into one of:

- `.github/extensions/drum-machine/` (project, committed)
- `~/.copilot/extensions/drum-machine/` (user, personal)

Then reload extensions in Copilot and open the **FM Drum Machine** canvas.

## Files

- `.github/extensions/drum-machine/extension.mjs` — SDK wiring: serves the renderer on
  a loopback port, persists kit state, streams live updates over SSE, and registers the
  `drum_*` tools plus the style generator.
- `.github/extensions/drum-machine/ui.html` — the self-contained Web Audio app
  (sequencer UI + FM engine + LFO engine + SSE client).
