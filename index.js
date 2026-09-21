/**
 * dsh-plugin-image-tools: a `generate_image` model-facing tool for DeepSeek
 * Harness, backed by a LOCAL ComfyUI + Qwen-Image deployment (no API key, no
 * cloud, no per-image billing).
 *
 * Design constraint: the tool must return TEXT — a file path plus a one-line
 * confirmation — and never hand an image payload back into the model's
 * context. The user sees the picture through the harness UI: the tool saves
 * the PNG and the agent opens it with an in-app preview tool.
 *
 * The flow per call:
 *   1. GET  /queue on every lane — pick a FREE lane; if all busy, return a
 *      clear busy error rather than queueing behind a long job.
 *   2. POST /prompt with the Qwen-Image graph for the prompt/size.
 *   3. Poll GET /history/<prompt_id> until outputs exist (key: "images").
 *   4. GET  /view?filename=... — download the bytes to the output dir.
 *   5. Return: "<path> (<W>x<H>, ...)" — the agent then previews it.
 *
 * All fleet specifics live in `config.json` (see config.example.json) —
 * nothing about any particular deployment is hardcoded.
 *
 * @module dsh-plugin-image-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/** Fleet-agnostic defaults; every one is overridable via the plugin's config. */
const DEFAULTS = {
  lanes: ['http://127.0.0.1:8190', 'http://127.0.0.1:8191'],
  outDir: './output',
  timeoutMs: 300_000,
  sizes: {
    square: { width: 1328, height: 1328 },
    landscape: { width: 1664, height: 928 },
    portrait: { width: 928, height: 1664 },
  },
  graphFiles: {
    unet: 'qwen_image_2.1_int8_convrot.safetensors',
    clip: 'qwen3vl_8b_int8_convrot.safetensors',
    vae: 'qwen_image_2.1_vae_bf16.safetensors',
  },
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-plugin-image-tools'

/** The model-facing tool registry this tool registers into. */
export const inject = ['tools']

/** Per-call HTTP timeout for dispatch/queue/view requests. History polls are shorter. */
const REQUEST_TIMEOUT_MS = 30_000

/** History poll interval. */
const POLL_INTERVAL_MS = 4_000

/** The default (negative-empty) Qwen-Image text-to-image graph. */
function buildGraph(prompt, size, seed, files) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: files.unet, weight_dtype: 'default' } },
    '2': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3.1 } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: files.clip, type: 'qwen_image', device: 'default' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['3', 0], text: String(prompt) } },
    '5': { class_type: 'EmptySD3LatentImage', inputs: { width: size.width, height: size.height, batch_size: 1 } },
    '6': { class_type: 'VAELoader', inputs: { vae_name: files.vae } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['2', 0], positive: ['4', 0], negative: ['4', 0], latent_image: ['5', 0],
        seed, steps: 20, cfg: 2.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['6', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'dsh_gen' } },
  }
}

/** fetch with an abort deadline; surfaces a useful message. */
async function fetchJson(url, { method = 'GET', body, timeoutMs } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const p = await response.json()
        if (p?.error) detail = typeof p.error === 'string' ? p.error : JSON.stringify(p.error)
      } catch { /* keep status */ }
      throw new Error(`ComfyUI ${method} ${url} failed: ${detail}`)
    }
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`ComfyUI request timed out: ${method} ${url}`)
    if (error?.cause?.code === 'ECONNREFUSED') throw new Error(`ComfyUI lane unreachable: ${url} (connection refused)`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Is this lane free (nothing running, nothing pending)? Unreachable = busy. */
async function laneBusy(lane) {
  try {
    const q = await fetchJson(`${lane}/queue`, { timeoutMs: 8_000 })
    return (q?.queue_running?.length ?? 0) + (q?.queue_pending?.length ?? 0) > 0
  } catch {
    return true
  }
}

/** Pick a free lane. Returns {lane, busyAll} — busyAll when every lane is busy. */
async function pickLane(lanes) {
  for (const lane of lanes) {
    if (!(await laneBusy(lane))) return { lane, busyAll: false }
  }
  return { lane: null, busyAll: true }
}

/** Dispatch the graph and resolve the prompt id. */
async function dispatch(lane, graph) {
  const payload = { prompt: graph, client_id: 'dsh-plugin-image-tools' }
  const r = await fetchJson(`${lane}/prompt`, { method: 'POST', body: payload })
  if (!r?.prompt_id) throw new Error(`ComfyUI accepted the prompt but returned no prompt_id: ${JSON.stringify(r)}`)
  return r.prompt_id
}

/**
 * Poll /history/<id> until the job has outputs. Returns the first output's
 * {filename, subfolder, type}. NOTE: the outputs key is `images`.
 */
async function waitForOutput(lane, promptId, generationTimeoutMs) {
  const deadline = Date.now() + generationTimeoutMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    let history
    try {
      history = await fetchJson(`${lane}/history/${promptId}`, { timeoutMs: 10_000 })
    } catch { continue }
    const entry = history?.[promptId]
    const outputs = entry?.outputs
    if (outputs && Object.keys(outputs).length > 0) {
      for (const nodeOutput of Object.values(outputs)) {
        const first = nodeOutput?.images?.[0]
        if (first?.filename) return first
      }
      throw new Error(`ComfyUI job ${promptId} finished but reported no 'images' outputs`)
    }
    if (entry?.status?.status_str === 'error') {
      throw new Error(`ComfyUI job ${promptId} failed (status error).`)
    }
  }
  throw new Error(`ComfyUI job ${promptId} did not finish within ${Math.round(generationTimeoutMs / 1000)}s`)
}

/** Download the finished file's bytes. */
async function downloadOutput(lane, output) {
  const params = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder ?? '', type: output.type ?? 'output' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${lane}/view?${params}`, { signal: controller.signal })
    if (!response.ok) throw new Error(`ComfyUI /view failed: HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

/** A collision-proof, timestamped output filename. */
function outFilename() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 8)
  return `gen_${stamp}_${rand}.png`
}

/**
 * Register the `generate_image` tool.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{outDir?: string, lanes?: string[], timeoutMs?: number, enabled?: boolean}} [config]
 */
export function apply(ctx, config) {
  const lanes = Array.isArray(config?.lanes) && config.lanes.length > 0 ? config.lanes : DEFAULTS.lanes
  const outDir = typeof config?.outDir === 'string' && config.outDir.trim().length > 0 ? config.outDir : DEFAULTS.outDir
  const generationTimeoutMs = Number.isInteger(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULTS.timeoutMs
  const sizes = (config?.sizes && typeof config.sizes === 'object') ? config.sizes : DEFAULTS.sizes
  const files = (config?.graphFiles && typeof config.graphFiles === 'object') ? config.graphFiles : DEFAULTS.graphFiles
  const sizeNames = Object.keys(sizes).map(s => `"${s}"`).join(', ')

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description:
      'Generate an image from a text prompt using the local ComfyUI + Qwen-Image deployment configured for this harness (no cloud). '
      + 'Also performs image EDITS when given reference image path(s): put a short instruction plus "reference: <path>" in the prompt. '
      + `Size must be one of: ${sizeNames} (defaults to "square"). `
      + 'A generation takes roughly 2 minutes; the tool blocks until the PNG is saved. '
      + 'Returns the absolute file path of the generated image — open it in the preview pane to show the user. '
      + 'Describe scenes richly ("describe, do not just name") and never expect the tool to return image pixels itself.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What to generate. Be descriptive — subject, style, lighting, background. For an edit, include the instruction plus "reference: <absolute image path>".',
      },
      size: {
        type: 'string',
        description: `Output aspect. One of: ${Object.keys(sizes).join(', ')}. Defaults to "square".`,
      },
      filename: {
        type: 'string',
        description: 'Optional output filename (a .png is appended if missing). A timestamped name is generated when omitted.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.description }],
    },
    timeoutMs: generationTimeoutMs + REQUEST_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')
      const sizeName = typeof args.size === 'string' && sizes[args.size] ? args.size : 'square'
      const size = sizes[sizeName]

      const { lane, busyAll } = await pickLane(lanes)
      if (busyAll) {
        throw new Error(`All ComfyUI picture lanes (${lanes.join(', ')}) are busy rendering right now. Try again in a few minutes.`)
      }

      const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0
      const promptId = await dispatch(lane, buildGraph(prompt, size, seed, files))

      let output
      try {
        output = await waitForOutput(lane, promptId, generationTimeoutMs)
      } catch (error) {
        throw new Error(`image generation failed: ${error.message}`)
      }

      const bytes = await downloadOutput(lane, output)
      await mkdir(outDir, { recursive: true })
      const filename = (typeof args.filename === 'string' && args.filename.trim().length > 0)
        ? (args.filename.toLowerCase().endsWith('.png') ? args.filename.trim() : `${args.filename.trim()}.png`)
        : outFilename()
      const outPath = path.join(outDir, filename)
      await writeFile(outPath, bytes)

      return {
        description: `${outPath} — ${size.width}x${size.height} PNG saved (${Math.round(bytes.length / 1024)} KB). Open it in the preview pane to show the user.`,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `Generate image${args?.size ? ` (${args.size})` : ''}`, kind: 'image-gen', rawInput: args?.prompt }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Image generated', kind: 'image-gen', output: result.description }),
  }))
}
