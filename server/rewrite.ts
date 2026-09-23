// The prompt "rewrite" helper: settings (which backend/model), secrets (.env), and the LLM call.
//
// - settings.json (project root, gitignored) holds non-secret choices and is written by the Settings screen.
// - .env (project root, gitignored) holds API keys. The app reads it on each request, never writes it,
//   and never sends key values to the browser — only whether a key is present.

import Anthropic from '@anthropic-ai/sdk'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import type { AppSettings, RewriteRequest, RewriteResult, SettingsResponse } from '../src/types.ts'
import { ollamaBaseUrl, ollamaModels } from './hermes-config.ts'

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url))
const SETTINGS_FILE = path.join(PROJECT_DIR, 'settings.json')
export const ENV_FILE = path.join(PROJECT_DIR, '.env')

const DEFAULTS: AppSettings = { rewrite: { backend: 'ollama', model: 'qwen3.8:27b' } }
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5'

// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1'])

export class RewriteError extends Error {}

// --- Settings & secrets --------------------------------------------------------

export async function readSettings(): Promise<AppSettings> {
  try {
    const saved = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))
    return { rewrite: { ...DEFAULTS.rewrite, ...saved.rewrite } }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

export async function writeSettings(input: AppSettings): Promise<AppSettings> {
  const { backend, model } = input.rewrite ?? {}
  if (backend !== 'ollama' && backend !== 'anthropic') throw new RewriteError('Unknown backend')
  if (typeof model !== 'string' || !model.trim()) throw new RewriteError('Choose a model')
  const settings: AppSettings = { rewrite: { backend, model: model.trim() } }
  // Write-then-rename so a crash mid-write can't leave a truncated file.
  await writeFile(`${SETTINGS_FILE}.tmp`, `${JSON.stringify(settings, null, 2)}\n`)
  await rename(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE)
  return settings
}

async function readEnv(): Promise<Record<string, string | undefined>> {
  try { return parseEnv(await readFile(ENV_FILE, 'utf8')) } catch { return {} }
}

async function anthropicKey(): Promise<string | null> {
  return (await readEnv()).ANTHROPIC_API_KEY?.trim() || null
}

export async function settingsResponse(): Promise<SettingsResponse> {
  return {
    settings: await readSettings(),
    anthropicKeyPresent: Boolean(await anthropicKey()),
    envFile: ENV_FILE,
    ollamaUrl: await ollamaBaseUrl(),
  }
}

/** Models the rewriter can use on a backend. */
export async function rewriteModels(backend: string): Promise<string[]> {
  if (backend === 'ollama') {
    const base = await ollamaBaseUrl()
    if (!base) throw new RewriteError('No local Ollama provider found in Hermes config.yaml')
    return (await ollamaModels(base)).map((m) => m.name)
  }
  if (backend === 'anthropic') {
    const apiKey = await anthropicKey()
    if (!apiKey) throw new RewriteError(`Add ANTHROPIC_API_KEY to ${ENV_FILE}`)
    const ids: string[] = []
    for await (const m of new Anthropic({ apiKey }).models.list()) ids.push(m.id)
    return ids
  }
  throw new RewriteError('Unknown backend')
}

// --- The rewrite ---------------------------------------------------------------

const SYSTEM_PROMPT = `You improve prompts for scheduled jobs in Hermes Agent's cron system.

How a Hermes cron job runs:
- Each run is a fresh agent session with no memory of past chats. The prompt must be self-contained: task, sources (with URLs), output format, and rules.
- The agent's final message is delivered automatically (e.g. to Signal) exactly as written. The agent must not try to send messages itself.
- Hermes prepends its own instructions to every run, including: "If there is genuinely nothing new to report, respond with exactly [SILENT] to suppress delivery." Smaller models over-use this and go silent on tasks that should always produce output.
- Output is read in a chat app: plain text, short, no tables or heavy markdown.
- Schedule wording in the prompt ("every Monday") is context only; the schedule is configured separately.

Rewrite the user's prompt so it works well under those conditions:
1. Keep the user's intent, facts, URLs, names, and tone. Do not invent sources, requirements, or details they did not ask for.
2. State the task plainly, then the output format and length.
3. Decide whether the job is a monitor/digest (where "nothing new" is a legitimate outcome) or a job that must always produce output (greetings, reminders, fixed daily summaries).
   - Monitor: include an explicit rule: "If nothing is new since your previous run, respond with only [SILENT]."
   - Always-output: include an explicit rule: "Always reply with the <thing>. Never respond with [SILENT]."
4. End with a line making clear the final message is the deliverable itself (e.g. "Your final message is delivered to the user as-is; make it the <thing> itself.").
5. Be as short as the task allows. A one-line task deserves a few lines, not a page.
6. Write the prompt in the second person, addressed to the agent.

Reply in exactly this format and nothing else:
<prompt>
the rewritten prompt
</prompt>
<notes>
- one short bullet per meaningful change
</notes>`

function userMessage(req: RewriteRequest): string {
  const ctx = [
    req.name && `Job name: ${req.name}`,
    req.schedule && `Schedule: ${req.schedule}`,
    req.deliver && `Delivered to: ${req.deliver}`,
    req.continuity !== undefined && `Continuity (sees its previous output each run): ${req.continuity ? 'on' : 'off'}`,
    req.model && `Runs on model: ${req.model}`,
  ].filter(Boolean).join('\n')
  return `${ctx}\n\nCurrent prompt:\n<current>\n${req.prompt}\n</current>`
}

function parseReply(text: string): { prompt: string; notes: string[] } {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const prompt = clean.match(/<prompt>\s*([\s\S]*?)\s*<\/prompt>/)?.[1]
    // Models sometimes drop the closing tag or all tags; take what's there rather than fail.
    ?? clean.match(/<prompt>\s*([\s\S]*?)(?:<notes>|$)/)?.[1]?.trim()
    ?? clean
  const notesBlock = clean.match(/<notes>\s*([\s\S]*?)\s*(?:<\/notes>|$)/)?.[1] ?? ''
  const notes = notesBlock.split('\n').map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean)
  return { prompt, notes }
}

async function viaOllama(model: string, req: RewriteRequest, signal: AbortSignal): Promise<string> {
  const base = await ollamaBaseUrl()
  if (!base) throw new RewriteError('No local Ollama provider found in Hermes config.yaml')
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userMessage(req) }],
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]),
  })
  if (!res.ok) throw new RewriteError(`Ollama error ${res.status}: ${await res.text()}`)
  const data = await res.json() as { message?: { content?: string } }
  return data.message?.content ?? ''
}

async function viaAnthropic(model: string, req: RewriteRequest, signal: AbortSignal): Promise<string> {
  const apiKey = await anthropicKey()
  if (!apiKey) throw new RewriteError(`Add ANTHROPIC_API_KEY to ${ENV_FILE}`)
  const client = new Anthropic({ apiKey })
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: userMessage(req) }],
  }
  try {
    // On models that support it, a refused request is retried server-side on a fallback model.
    const msg = FALLBACK_MODELS.has(model)
      ? await client.beta.messages.create(
        { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : await client.messages.create(params, { signal })
    if (msg.stop_reason === 'refusal') throw new RewriteError('The model declined to rewrite this prompt.')
    return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new RewriteError('Anthropic rejected the API key in .env')
    if (err instanceof Anthropic.NotFoundError) throw new RewriteError(`Unknown Anthropic model: ${model}`)
    if (err instanceof Anthropic.RateLimitError) throw new RewriteError('Anthropic rate limit hit; try again shortly')
    if (err instanceof Anthropic.APIError) throw new RewriteError(`Anthropic error ${err.status}: ${err.message}`)
    throw err
  }
}

export async function rewritePrompt(req: RewriteRequest, signal: AbortSignal): Promise<RewriteResult> {
  if (!req.prompt?.trim()) throw new RewriteError('Write a prompt first, then ask for a rewrite.')
  const { backend, model } = (await readSettings()).rewrite
  const started = Date.now()
  const text = backend === 'anthropic' ? await viaAnthropic(model, req, signal) : await viaOllama(model, req, signal)
  const parsed = parseReply(text)
  if (!parsed.prompt.trim()) throw new RewriteError(`${model} returned an empty rewrite. Try again or pick another model in Settings.`)
  return { ...parsed, backend, model, ms: Date.now() - started }
}
