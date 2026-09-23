// Read-only helpers for Hermes's own config: which models and providers are available,
// and what an unpinned job falls back to. Nothing here writes to ~/.hermes.

import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ModelGroup } from '../src/types.ts'

export const HERMES_HOME = process.env.HERMES_HOME ?? path.join(os.homedir(), '.hermes')

interface HermesConfig {
  model?: { default?: string; provider?: string }
  cron?: { model?: string }
  providers?: Record<string, { name?: string; base_url?: string; models?: Record<string, unknown> | string[] }>
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path.join(HERMES_HOME, file), 'utf8')) } catch { return null }
}

export async function readHermesConfig(): Promise<HermesConfig> {
  try { return parseYaml(await readFile(path.join(HERMES_HOME, 'config.yaml'), 'utf8')) ?? {} } catch { return {} }
}

/** The model an unpinned job falls back to: cron.model, else model.default. */
export async function readDefaultModel(): Promise<string | null> {
  const cfg = await readHermesConfig()
  return cfg.cron?.model ?? cfg.model?.default ?? null
}

/** Base URL of Hermes's configured local Ollama provider, if any (without the /v1 suffix). */
export async function ollamaBaseUrl(): Promise<string | null> {
  const cfg = await readHermesConfig()
  for (const p of Object.values(cfg.providers ?? {})) {
    if (p.base_url && /:11434\b/.test(p.base_url)) return p.base_url.replace(/\/v1\/?$/, '')
  }
  return null
}

export interface OllamaModel { name: string; size: string | null }

/** Models installed in the local Ollama, embeddings excluded (they can't run a job). */
export async function ollamaModels(base: string): Promise<OllamaModel[]> {
  const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`)
  const data = await res.json() as { models?: { name: string; details?: { parameter_size?: string; family?: string } }[] }
  return (data.models ?? [])
    .filter((m) => !/embed/i.test(m.name) && !/bert/i.test(m.details?.family ?? ''))
    .map((m) => ({ name: m.name, size: m.details?.parameter_size ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Env vars that mean a provider is usable without an OAuth login. Only names are checked.
const ENV_KEYS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN'],
  openrouter: ['OPENROUTER_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  nous: ['NOUS_API_KEY'],
}

async function envKeysPresent(): Promise<Set<string>> {
  const present = new Set<string>()
  let text = ''
  try { text = await readFile(path.join(HERMES_HOME, '.env'), 'utf8') } catch { return present }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(\S+)/) // uncommented, non-empty assignments only
    if (m) present.add(m[1])
  }
  return present
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic', 'openai-codex': 'OpenAI Codex', copilot: 'GitHub Copilot',
  openrouter: 'OpenRouter', nous: 'Nous', openai: 'OpenAI',
}

/**
 * Models a job can be pinned to, grouped by the provider id Hermes expects in `--provider`.
 * Local providers come first; cloud providers are listed only when Hermes has credentials
 * for them (OAuth pool / auth.json, an API key in ~/.hermes/.env, or Claude Code's login).
 */
export async function listModelGroups(): Promise<ModelGroup[]> {
  const cfg = await readHermesConfig()
  const groups: ModelGroup[] = []

  for (const [key, p] of Object.entries(cfg.providers ?? {})) {
    if (!p.base_url) continue
    const provider = `custom:${key}`
    let models: { id: string; label: string }[] = []
    if (/:11434\b/.test(p.base_url)) {
      try {
        models = (await ollamaModels(p.base_url.replace(/\/v1\/?$/, '')))
          .map((m) => ({ id: m.name, label: m.size ? `${m.name} · ${m.size}` : m.name }))
      } catch { /* Ollama down: fall back to the config's list below */ }
    }
    if (!models.length) {
      const names = Array.isArray(p.models) ? p.models : Object.keys(p.models ?? {})
      models = names.filter((n) => !/embed/i.test(n)).map((n) => ({ id: n, label: n }))
    }
    if (models.length) groups.push({ provider, label: p.name ?? key, models })
  }

  const auth = await readJson<{ providers?: Record<string, unknown>; credential_pool?: Record<string, unknown[]> }>('auth.json')
  // `hermes auth remove` leaves an empty pool entry behind, so only count pools that hold a credential.
  const pooled = Object.entries(auth?.credential_pool ?? {}).filter(([, creds]) => Array.isArray(creds) && creds.length).map(([p]) => p)
  const signedIn = new Set([...Object.keys(auth?.providers ?? {}), ...pooled])
  const env = await envKeysPresent()
  for (const [provider, names] of Object.entries(ENV_KEYS)) if (names.some((n) => env.has(n))) signedIn.add(provider)
  // With no key of its own, Hermes borrows Claude Code's login for Anthropic.
  if (await stat(path.join(os.homedir(), '.claude', '.credentials.json')).then((s) => s.size > 2, () => false)) signedIn.add('anthropic')

  const cache = await readJson<Record<string, { models?: string[] }>>('provider_models_cache.json') ?? {}
  for (const [provider, entry] of Object.entries(cache)) {
    if (provider.startsWith('custom:') || !signedIn.has(provider) || !entry.models?.length) continue
    const models = [...new Set(entry.models)].sort().map((id) => ({ id, label: id }))
    groups.push({ provider, label: PROVIDER_LABELS[provider] ?? provider, models })
  }
  return groups
}
