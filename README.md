# DeepSeek-Harness-Image-Tools

> ⚠️ **Unofficial community project.** Not affiliated with or endorsed by DeepSeek. Community tooling for the [DeepSeek Harness](https://github.com/tonyd2wild) (`dsh`) agent harness.
>
> 🔒 **Security note:** this tool has no authentication of its own and talks to your ComfyUI endpoint in plain HTTP. Keep both on `127.0.0.1` or inside a trusted network (Tailscale/WireGuard), and never expose them directly to the internet.

A model-facing **`generate_image`** tool for DeepSeek Harness, backed by **your own local ComfyUI + Qwen-Image deployment**. No cloud, no API key, no per-image billing.

The agent writes a prompt; ComfyUI renders a real PNG on your GPU; the tool returns **the file path as text** (never pixels into the model's context) and the agent shows it with an in-app preview tool.

```
generate_image("a white AF1 on a grey studio sweep")  →  "/path/to/out_00001_.png (1328x1328)"
```

## What it gives the agent

- **`generate_image`** — text → PNG. Describe richly ("a calm orange tabby cat wearing a tiny red knitted scarf, sitting on a wooden pier at sunrise") rather than naming; describe, don't just name, for anything that shares a silhouette with something else in frame.
- **Edits** — pass `reference: <absolute image path>` inside the prompt with a short instruction to run a multi-reference edit (up to 10 refs on the Qwen-Image graph).
- **`size`** — `square` (1328×1328), `landscape` (1664×928), `portrait` (928×1664) — the sizes the model was checked at.
- **Queue awareness** — checks both picture lanes' queues before dispatch; returns a clear "both lanes busy" error instead of silently queueing behind a two-hour video render.
- **Text-path-return discipline** — the tool NEVER hands image bytes into model context; it saves the PNG and returns its absolute path.

## Requirements

- Node ≥ 18, a running dsh install
- **ComfyUI** with a Qwen-Image checkpoint, reachable over HTTP (the OpenAI-style `/prompt`, `/history`, `/view` API)
- The exact node graph lives in `graph.js`; point `config.json` at your lanes

## Install

```bash
# 1. clone next to your other plugins
git clone https://github.com/tonyd2wild/DeepSeek-Harness-Image-Tools.git ~/.dsh/plugins/image-tools

# 2. install its one dependency
cd ~/.dsh/plugins/image-tools && npm install --ignore-scripts

# 3. wire it into dsh (host plane)
dsh plugin --profile <your-profile> add link:~/.dsh/plugins/image-tools
#    then add a loader row to your profile's cordis.patch.yml:
#    - id: dsh-plugin-image-tools
#      name: 'dsh-plugin-image-tools'

# 4. add the agent-plane row to your preset's agent.cordis.yml:
#    - id: tool-image-gen
#      name: 'dsh-plugin-image-tools'
#      config:
#        lanes:  ["http://127.0.0.1:8190", "http://127.0.0.1:8191"]
#        outDir: "/absolute/writeable/output/dir"

# 5. create a NEW session (presets mount lazily; a running session keeps its old catalog)
```

## Configuration

All fleet specifics live in config — nothing about our hardware is hardcoded:

| key | default | meaning |
|---|---|---|
| `lanes` | `["http://100.113.64.18:8190","http://100.113.64.18:8191"]` | ComfyUI HTTP endpoints (one per GPU) |
| `outDir` | `./output` | where finished PNGs are written |
| `timeoutMs` | `330000` | per-call timeout (a generation takes ~2 min) |

## The graph (Qwen-Image 2.1, INT8)

`UNETLoader → ModelSamplingAuraFlow (shift 3.1) → KSampler (euler/simple, cfg 2.5, 20 steps)`, `CLIPLoader (type qwen_image)`, `EmptySD3LatentImage`, `VAEDecode`, `SaveImage`. Files: `qwen_image_2.1_int8_convrot.safetensors`, `qwen3vl_8b_int8_convrot.safetensors`, `qwen_image_2.1_vae_bf16.safetensors`.

**Measured:** 1328×1328, 20 steps = **111 seconds** on one RTX 3090.

## Prompting notes (measured on this build)

- **Describe, do not just name.** "Goku, Vegeta, Cell, Frieza" rendered **two Gokus**; describing Vegeta's hair and scowl fixed it. Any subject sharing a silhouette with another in frame needs describing.
- **Concepts, moods, backgrounds, fits:** excellent, use freely.
- **A specific real product you are selling:** do not. It knows what a Jordan 4 *is* and will confidently invent a colorway that does not exist.
- **Logos:** big simple marks land. Small text does not.

## VRAM note

The picture lanes share cards with video lanes in a common fleet layout (~16.5 GB + ~17 GB on 24 GB cards). **They do not both fit.** The tool checks `/queue` before dispatching and refuses with a clear message when both lanes are busy, rather than queueing behind a long job. If you co-locate, free the sibling lane first (`POST /free` with `{"unload_models": true, "free_memory": true}`), which unloads weights without killing the process; reload costs 30–60 s, an OOM costs the whole job.

## Sibling projects

- [DeepSeek-Harness-Video-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Video-Tools) — `generate_video` / `check_video` (MiniMax H3, async two-call)
- [DeepSeek-Harness-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Tools) — the hub index of all dsh community tools
- [DeepSeek-Harness-Vision-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Vision-Tools) — `analyze_image` (give dsh eyes)
- [DeepSeek-Harness-Web-Tools](https://github.com/tonyd2wild/DeepSeek-Harness-Web-Tools) — keyless `web_search` / `web_fetch`
- [DeepSeek-Harness-Browser](https://github.com/tonyd2wild/DeepSeek-Harness-Browser) — the in-app browser pane

## Contributing

Issues and PRs welcome. Keep the "⚠️ Unofficial community project" banner, keep endpoints in config (never hardcoded), and remember the design constraint: **tools return text, never image payloads.**

## License

MIT — see [LICENSE](LICENSE).
