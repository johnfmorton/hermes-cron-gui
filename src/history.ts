import { api } from './api.ts'
import type { OutputFile, Run } from './types.ts'
import { $, esc, fmtBytes, fmtDate } from './util.ts'

const STATUS_CLASS: Record<string, string> = {
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  running: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  claimed: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
}
const statusBadge = (s: string) =>
  `<span class="badge ${STATUS_CLASS[s] ?? 'bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300'}">${esc(s)}</span>`

function duration(r: Run): string {
  if (!r.started_at || !r.finished_at) return '—'
  const s = (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

// What each tab last rendered, so a background refresh only touches the DOM when data changed.
let runsKey = ''
let outputsKey = ''

const ACTIVE = new Set(['claimed', 'running'])

/**
 * Render the Runs tab. With `refresh: true` (background poll) nothing is re-rendered unless the
 * data changed. Returns whether any run is still in progress, so the caller can poll faster.
 */
export async function renderRuns(root: HTMLElement, jobId: string, { refresh = false } = {}): Promise<boolean> {
  if (!refresh) root.innerHTML = '<p class="text-sm text-stone-500">Loading…</p>'
  const runs = await api.runs(jobId)
  const active = runs.some((r) => ACTIVE.has(r.status))
  const key = `${jobId}:${JSON.stringify(runs)}`
  if (refresh && key === runsKey) return active
  runsKey = key
  if (!runs.length) {
    root.innerHTML = '<p class="text-sm text-stone-500">No runs recorded yet.</p>'
    return active
  }
  // A job can look healthy from manual runs yet never have completed a scheduled one.
  const scheduledOk = runs.some((r) => r.source === 'builtin' && r.status === 'completed')
  // A model can "succeed" by replying [SILENT] to a task that should always produce output.
  const latest = runs.find((r) => r.status === 'completed')
  const notes = [
    scheduledOk ? '' : 'No scheduled run in this history has completed. Only manual runs have succeeded, or none have.',
    latest?.silent ? `The latest completed run replied [SILENT], so nothing was delivered${latest.model ? ` (model: ${latest.model})` : ''}. If this job should always produce output, small models can over-use [SILENT]: pin a stronger model or tell the prompt never to reply [SILENT].` : '',
  ].filter(Boolean)
  root.innerHTML = `
    ${notes.map((n) => `<p class="warn mb-4">${esc(n)}</p>`).join('')}
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="text-xs text-stone-500 uppercase">
          <tr><th class="py-2 pr-4 font-medium">Status</th><th class="py-2 pr-4 font-medium">Trigger</th>
            <th class="py-2 pr-4 font-medium">Started</th><th class="py-2 pr-4 font-medium">Duration</th>
            <th class="py-2 pr-4 font-medium">Model</th><th class="py-2 font-medium">Delivery</th></tr>
        </thead>
        <tbody class="divide-y divide-stone-200 dark:divide-stone-800">
          ${runs.map((r) => `
            <tr class="align-top">
              <td class="py-2 pr-4">${statusBadge(r.status)}</td>
              <td class="py-2 pr-4">${r.source === 'builtin' ? 'Scheduled' : r.source === 'direct' ? 'Manual' : esc(r.source)}</td>
              <td class="py-2 pr-4 whitespace-nowrap" title="${esc(r.claimed_at)}">${esc(fmtDate(r.started_at ?? r.claimed_at))}</td>
              <td class="py-2 pr-4">${duration(r)}</td>
              <td class="py-2 pr-4 font-mono text-xs" title="${r.tokens ? `${r.tokens} tokens` : ''}">${esc(r.model ?? '—')}</td>
              <td class="py-2">${r.silent
                ? '<span class="badge bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200" title="The agent replied [SILENT]">silent, nothing sent</span>'
                : esc(r.delivery_outcome ?? '—')}</td>
            </tr>
            ${r.error ? `<tr><td colspan="6" class="pb-3"><pre class="error-box overflow-x-auto text-xs whitespace-pre-wrap">${esc(r.error)}</pre></td></tr>` : ''}`).join('')}
        </tbody>
      </table>
    </div>`
  return active
}

/** The agent's final answer, i.e. the text after the last "## Response" (or "## Error") heading. */
function extractResponse(md: string): string {
  const lines = md.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^## (Response|Error)\s*$/.test(lines[i])) return lines.slice(i + 1).join('\n').trim()
  }
  return md
}

function fileList(files: OutputFile[], selected: string): string {
  return files.map((f) => `
    <li><button type="button" data-file="${esc(f.name)}" aria-current="${f.name === selected}"
      class="w-full rounded-md px-2.5 py-1.5 text-left hover:bg-stone-100 aria-[current=true]:bg-indigo-50 dark:hover:bg-stone-800 dark:aria-[current=true]:bg-indigo-950">
      <span class="block font-mono text-xs">${esc(f.name.replace(/\.md$/, '').replace('_', ' '))}</span>
      <span class="text-xs text-stone-500">${f.failed ? '<span class="text-red-600 dark:text-red-400">failed</span> · ' : ''}${fmtBytes(f.size)}</span>
    </button></li>`).join('')
}

/**
 * Render the Output tab. On a background refresh, only the file list is updated (when a new run
 * saved output), keeping the file you're reading, its scroll position, and the view toggle.
 */
export async function renderOutputs(root: HTMLElement, jobId: string, { refresh = false } = {}) {
  if (!refresh) root.innerHTML = '<p class="text-sm text-stone-500">Loading…</p>'
  const files = await api.outputs(jobId)
  const key = `${jobId}:${JSON.stringify(files)}`
  if (refresh && key === outputsKey) return
  outputsKey = key

  const list = root.querySelector<HTMLElement>('[data-files]')
  if (refresh && list && files.length) {
    const selected = list.querySelector<HTMLElement>('[aria-current="true"]')?.dataset.file ?? ''
    list.innerHTML = fileList(files, selected)
    return
  }
  if (!files.length) {
    root.innerHTML = '<p class="text-sm text-stone-500">No saved output yet.</p>'
    return
  }
  root.innerHTML = `
    <div class="grid gap-4 lg:grid-cols-[14rem_1fr]">
      <ul class="space-y-1 text-sm" data-files>${fileList(files, files[0].name)}</ul>
      <div class="min-w-0">
        <label class="mb-2 flex items-center gap-2 text-sm">
          <input type="checkbox" data-response-only checked /> Final response only</label>
        <pre data-viewer class="max-h-[70vh] overflow-auto rounded-md border border-stone-200 bg-white p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap dark:border-stone-800 dark:bg-stone-900"></pre>
      </div>
    </div>`

  const viewer = $('[data-viewer]', root)
  const toggle = $<HTMLInputElement>('[data-response-only]', root)
  let raw = ''
  const show = () => { viewer.textContent = toggle.checked ? extractResponse(raw) : raw }

  async function load(name: string) {
    viewer.textContent = 'Loading…'
    raw = await api.output(jobId, name)
    show()
  }

  toggle.addEventListener('change', show)
  $('[data-files]', root).addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-file]')
    if (!btn) return
    root.querySelectorAll('[data-file]').forEach((b) => b.setAttribute('aria-current', String(b === btn)))
    load(btn.dataset.file!)
  })
  await load(files[0].name)
}
