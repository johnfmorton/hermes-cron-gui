// Local API for the GUI, mounted into Vite's dev and preview servers at /api.
//
// Reads come straight from ~/.hermes (jobs.json, output/, executions.db) — read-only.
// Every change goes through the `hermes cron` CLI so Hermes's own validation and
// file locking apply; this app never writes to ~/.hermes itself.

import { execFile } from 'node:child_process'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Connect, Plugin } from 'vite'
import type {
  AppSettings, Channel, CommandResult, JobInput, JobsResponse, MetaResponse, OutputFile, RewriteRequest, Run,
} from '../src/types.ts'
import { HERMES_HOME, listModelGroups, readDefaultModel } from './hermes-config.ts'
import { RewriteError, rewriteModels, rewritePrompt, settingsResponse, writeSettings } from './rewrite.ts'

const HERMES_BIN = process.env.HERMES_BIN ?? 'hermes'
const CRON_DIR = path.join(HERMES_HOME, 'cron')

// From hermes-agent/cron/scheduler_delivery.py (_KNOWN_DELIVERY_PLATFORMS).
const PLATFORMS = [
  'signal', 'telegram', 'discord', 'slack', 'whatsapp', 'matrix', 'mattermost', 'email', 'sms',
  'webhook', 'homeassistant', 'bluebubbles', 'dingtalk', 'feishu', 'wecom', 'weixin', 'qqbot',
]

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/
const OUTPUT_FILE = /^[\w.-]+\.md$/

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

// --- CLI ---------------------------------------------------------------------

function hermes(args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    // execFile: no shell, so prompts and names are passed verbatim.
    execFile(HERMES_BIN, ['cron', ...args], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim()
      resolve({ ok: !err, output: output || (err ? String(err.message) : '') })
    })
  })
}

// `--flag=value` keeps argparse from reading values that start with "-" as flags.
const opt = (flag: string, value: string) => `--${flag}=${value}`

function commonArgs(input: JobInput, editing: boolean): string[] {
  const a: string[] = []
  if (input.name !== undefined) a.push(opt('name', input.name))
  if (input.deliver !== undefined) a.push(opt('deliver', input.deliver))
  if (input.failureDeliver !== undefined && (editing || input.failureDeliver)) {
    a.push(opt('failure-deliver', input.failureDeliver))
  }
  if (input.repeat != null) a.push(opt('repeat', String(input.repeat)))
  // Clearing (empty string) is only meaningful on edit; on create just omit the flag.
  const clearable: [keyof JobInput, string][] = [
    ['script', 'script'], ['monitorScript', 'monitor-script'], ['monitorUrl', 'monitor-url'],
    ['workdir', 'workdir'], ['model', 'model'], ['provider', 'provider'],
    ['reasoningEffort', 'reasoning-effort'],
  ]
  for (const [key, flag] of clearable) {
    const v = input[key]
    if (typeof v === 'string' && (editing || v)) a.push(opt(flag, v))
  }
  if (input.skills) {
    if (editing && input.skills.length === 0) a.push('--clear-skills')
    for (const s of input.skills) a.push(opt('skill', s))
  }
  if (input.continuity === true) a.push('--continuity')
  if (editing && input.continuity === false) a.push('--no-continuity')
  if (input.noAgent === true) a.push('--no-agent')
  if (editing && input.noAgent === false) a.push('--agent')
  return a
}

function createArgs(input: JobInput): string[] {
  if (!input.schedule?.trim()) throw new HttpError(400, 'Schedule is required')
  const a = ['create', ...commonArgs(input, false)]
  if (input.paused) a.push('--paused')
  a.push('--', input.schedule.trim())
  if (input.prompt) a.push(input.prompt)
  return a
}

function editArgs(id: string, input: JobInput): string[] {
  const a = ['edit', ...commonArgs(input, true)]
  if (input.schedule !== undefined) a.push(opt('schedule', input.schedule.trim()))
  if (input.prompt !== undefined) a.push(opt('prompt', input.prompt))
  if (a.length === 1) throw new HttpError(400, 'Nothing to change')
  a.push('--', id)
  return a
}

// --- Reads -------------------------------------------------------------------

async function readJobs(): Promise<JobsResponse> {
  const raw = JSON.parse(await readFile(path.join(CRON_DIR, 'jobs.json'), 'utf8'))
  let heartbeatAgeSec: number | null = null
  try {
    const beat = Number(await readFile(path.join(CRON_DIR, 'ticker_heartbeat'), 'utf8'))
    if (Number.isFinite(beat)) heartbeatAgeSec = Math.max(0, Math.round(Date.now() / 1000 - beat))
  } catch { /* scheduler never ran */ }
  return { jobs: raw.jobs ?? [], updatedAt: raw.updated_at ?? null, heartbeatAgeSec }
}

async function readMeta(): Promise<MetaResponse> {
  const channels: Channel[] = []
  try {
    const dir = JSON.parse(await readFile(path.join(HERMES_HOME, 'channel_directory.json'), 'utf8'))
    for (const [platform, list] of Object.entries<any[]>(dir.platforms ?? {})) {
      for (const c of list ?? []) {
        channels.push({ platform, id: String(c.id), name: String(c.name ?? c.id), type: String(c.type ?? '') })
      }
    }
  } catch { /* no directory yet */ }

  // Skills live at skills/<category>/<name>/SKILL.md; the CLI takes the bare name.
  const skills: string[] = []
  try {
    const root = path.join(HERMES_HOME, 'skills')
    for (const cat of await readdir(root, { withFileTypes: true })) {
      if (!cat.isDirectory()) continue
      const entries = await readdir(path.join(root, cat.name), { withFileTypes: true })
      await Promise.all(entries.filter((s) => s.isDirectory()).map(async (s) => {
        try {
          await stat(path.join(root, cat.name, s.name, 'SKILL.md'))
          skills.push(s.name)
        } catch { /* not a skill (backups, caches) */ }
      }))
    }
  } catch { /* no skills dir */ }
  skills.sort()

  return { hermesHome: HERMES_HOME, platforms: PLATFORMS, channels, skills, defaultModel: await readDefaultModel() }
}

interface AuditEntry { ts: number; model: string | null; silent: boolean; tokens: number | null }

/**
 * usage_audit.jsonl records, per agent run, the model that actually ran and whether the reply was
 * [SILENT]. It shares no id with executions.db, but each entry is written as the run finishes.
 */
async function readAudit(jobId: string): Promise<AuditEntry[]> {
  let text: string
  try { text = await readFile(path.join(CRON_DIR, 'usage_audit.jsonl'), 'utf8') } catch { return [] }
  const entries: AuditEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.includes(jobId)) continue // cheap prefilter before JSON.parse
    try {
      const d = JSON.parse(line)
      if (d.job_id !== jobId) continue
      entries.push({ ts: Date.parse(d.ts), model: d.model ?? null, silent: Boolean(d.response_silent), tokens: d.total_tokens ?? null })
    } catch { /* partial line */ }
  }
  return entries
}

const AUDIT_MATCH_MS = 60_000

async function readRuns(jobId: string, limit: number): Promise<Run[]> {
  const dbPath = path.join(CRON_DIR, 'executions.db')
  let db: DatabaseSync
  try { db = new DatabaseSync(dbPath, { readOnly: true }) } catch { return [] }
  let runs: Run[]
  try {
    runs = db.prepare(
      `SELECT id, job_id, source, status, claimed_at, started_at, finished_at, error, delivery_outcome
       FROM executions WHERE job_id = ? ORDER BY claimed_at DESC LIMIT ?`,
    ).all(jobId, limit) as unknown as Run[]
  } finally {
    db.close()
  }
  const audit = await readAudit(jobId)
  for (const run of runs) {
    const end = run.finished_at ? Date.parse(run.finished_at) : NaN
    let best: AuditEntry | null = null
    for (const a of audit) {
      const gap = Math.abs(a.ts - end)
      if (gap <= AUDIT_MATCH_MS && (!best || gap < Math.abs(best.ts - end))) best = a
    }
    run.model = best?.model ?? null
    run.silent = best ? best.silent : null
    run.tokens = best?.tokens ?? null
  }
  return runs
}

async function listOutputs(jobId: string): Promise<OutputFile[]> {
  const dir = path.join(CRON_DIR, 'output', jobId)
  let names: string[]
  try { names = (await readdir(dir)).filter((n) => OUTPUT_FILE.test(n)) } catch { return [] }
  names.sort().reverse() // timestamped names, newest first
  return Promise.all(names.map(async (name) => {
    const file = path.join(dir, name)
    // Only the first line is needed to tell a failed run apart ("# Cron Job: X (FAILED)").
    const fh = await open(file)
    try {
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(256), 0, 256, 0)
      const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]
      return { name, size: (await fh.stat()).size, failed: firstLine.includes('(FAILED)') }
    } finally {
      await fh.close()
    }
  }))
}

async function readOutput(jobId: string, name: string): Promise<string> {
  if (!OUTPUT_FILE.test(name)) throw new HttpError(400, 'Bad file name')
  const file = path.join(CRON_DIR, 'output', jobId, name)
  if ((await stat(file)).size > 8 * 1024 * 1024) throw new HttpError(413, 'Output file too large')
  return readFile(file, 'utf8')
}

// --- HTTP --------------------------------------------------------------------

// This API runs shell commands on your behalf, so only answer same-origin requests
// to a loopback host. That blocks other sites (CSRF) and DNS-rebinding tricks.
function isTrusted(req: IncomingMessage): boolean {
  const host = req.headers.host ?? ''
  const hostname = host.replace(/:\d+$/, '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return false
  const origin = req.headers.origin
  if (origin) {
    try { if (new URL(origin).host !== host) return false } catch { return false }
  } else if (req.method !== 'GET') {
    return false
  }
  return true
}

async function readBody<T = JobInput>(req: IncomingMessage): Promise<T> {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json')
  }
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (data.length > 1_000_000) throw new HttpError(413, 'Body too large')
  }
  return (data ? JSON.parse(data) : {}) as T
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local')
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/') // after the /api mount
  const method = req.method ?? 'GET'
  const [resource, id, sub, file] = parts

  if (resource === 'jobs' && !id) {
    if (method === 'GET') return send(res, 200, await readJobs())
    if (method === 'POST') return send(res, 200, await hermes(createArgs(await readBody(req))))
  }
  if (resource === 'meta' && method === 'GET') return send(res, 200, await readMeta())
  if (resource === 'models' && method === 'GET') return send(res, 200, await listModelGroups())

  if (resource === 'settings') {
    if (method === 'GET') return send(res, 200, await settingsResponse())
    if (method === 'PUT') {
      await writeSettings(await readBody<AppSettings>(req))
      return send(res, 200, await settingsResponse())
    }
  }
  if (resource === 'rewrite') {
    if (method === 'GET' && id === 'models') {
      return send(res, 200, await rewriteModels(url.searchParams.get('backend') ?? ''))
    }
    if (method === 'POST' && !id) {
      // Stop the upstream LLM call if the user discards the rewrite (the browser aborts the fetch).
      const abort = new AbortController()
      res.on('close', () => { if (!res.writableFinished) abort.abort() })
      return send(res, 200, await rewritePrompt(await readBody<RewriteRequest>(req), abort.signal))
    }
  }

  if (resource === 'jobs' && id) {
    if (!JOB_ID.test(id)) throw new HttpError(400, 'Bad job id')
    if (!sub) {
      if (method === 'PATCH') return send(res, 200, await hermes(editArgs(id, await readBody(req))))
      if (method === 'DELETE') return send(res, 200, await hermes(['remove', '--', id]))
    }
    if (method === 'POST' && (sub === 'pause' || sub === 'resume' || sub === 'run')) {
      return send(res, 200, await hermes([sub, '--', id]))
    }
    if (method === 'GET' && sub === 'runs') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50))
      return send(res, 200, await readRuns(id, limit))
    }
    if (method === 'GET' && sub === 'outputs') {
      if (!file) return send(res, 200, await listOutputs(id))
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      return res.end(await readOutput(id, file))
    }
  }
  throw new HttpError(404, 'Not found')
}

const middleware: Connect.NextHandleFunction = (req, res) => {
  if (!isTrusted(req)) return send(res, 403, { error: 'Forbidden' })
  route(req, res).catch((err: unknown) => {
    const status = err instanceof HttpError ? err.status
      : err instanceof RewriteError ? 400
        : (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 404 : 500
    send(res, status, { error: err instanceof Error ? err.message : String(err) })
  })
}

export function hermesApi(): Plugin {
  return {
    name: 'hermes-cron-api',
    configureServer(server) { server.middlewares.use('/api', middleware) },
    configurePreviewServer(server) { server.middlewares.use('/api', middleware) },
  }
}
