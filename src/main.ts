import './style.css'
import { api } from './api.ts'
import { renderOutputs, renderRuns } from './history.ts'
import { renderJobForm } from './job-form.ts'
import { renderSettings } from './settings-view.ts'
import type { Job, MetaResponse, ModelGroup } from './types.ts'
import { $, deliverList, describeSchedule, esc, fmtDate, fmtRelative, jobWarnings } from './util.ts'

type Tab = 'settings' | 'runs' | 'output'
const TABS: [Tab, string][] = [['settings', 'Settings'], ['runs', 'Runs'], ['output', 'Output']]
const POLL_MS = 15_000

const state = {
  jobs: [] as Job[],
  meta: null as MetaResponse | null,
  models: [] as ModelGroup[],
  heartbeatAgeSec: null as number | null,
  /** Selected job id, 'new', 'settings', or null. Mirrored in the URL hash: #/<id>/<tab> */
  selected: null as string | null,
  tab: 'settings' as Tab,
  dirty: false,
}

const listEl = $('#job-list')
const detailEl = $('#detail')

// --- Helpers -----------------------------------------------------------------

let toastTimer = 0
function toast(message: string) {
  const el = $('#toast')
  el.textContent = message
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { el.hidden = true }, 6000)
}

const currentJob = () => state.jobs.find((j) => j.id === state.selected) ?? null

function stateBadge(job: Job): string {
  const [label, cls] = !job.enabled || job.state === 'paused'
    ? ['paused', 'bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300']
    : job.last_status && job.last_status !== 'ok'
      ? ['failing', 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300']
      : [job.state === 'scheduled' ? 'active' : job.state, 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300']
  return `<span class="badge ${cls}">${esc(label)}</span>`
}

const scheduleText = (job: Job) =>
  describeSchedule(job.schedule.expr ?? job.schedule_display) ?? job.schedule_display

// Unsaved-edit guarding happens in the hashchange handler, which covers links too.
function navigate(selected: string | null, tab: Tab = 'settings') {
  location.hash = selected ? `/${selected}${tab !== 'settings' ? `/${tab}` : ''}` : ''
}

function readHash() {
  const [, id, tab] = location.hash.split('/')
  state.selected = id || null
  state.tab = TABS.some(([t]) => t === tab) ? (tab as Tab) : 'settings'
}

// --- Rendering ---------------------------------------------------------------

function renderStatus() {
  const el = $('#scheduler-status')
  const age = state.heartbeatAgeSec
  // The ticker writes a heartbeat roughly every minute while the gateway is up.
  const alive = age !== null && age < 180
  el.innerHTML = `<span class="mr-1 inline-block size-2 rounded-full ${alive ? 'bg-emerald-500' : 'bg-red-500'}"></span>${
    alive ? 'Scheduler running' : age === null ? 'Scheduler has never run' : `Scheduler silent for ${Math.round(age / 60)} min. Is the gateway up?`}`
}

function renderList() {
  if (!state.jobs.length) {
    listEl.innerHTML = '<li class="p-5 text-sm text-stone-500">No jobs yet.</li>'
    return
  }
  listEl.innerHTML = state.jobs.map((job) => {
    const warn = jobWarnings(job).length > 0
    return `
      <li>
        <a href="#/${esc(job.id)}" aria-current="${job.id === state.selected}"
          class="block px-5 py-3.5 hover:bg-stone-100 aria-[current=true]:bg-indigo-50 dark:hover:bg-stone-900 dark:aria-[current=true]:bg-indigo-950/60">
          <div class="flex items-center gap-2">
            <span class="truncate font-medium">${esc(job.name || job.id)}</span>
            ${warn ? '<span class="text-amber-500" title="Needs attention">●</span>' : ''}
            <span class="ml-auto">${stateBadge(job)}</span>
          </div>
          <div class="mt-0.5 text-xs text-stone-500">${esc(scheduleText(job))}${
            job.next_run_at && job.enabled ? ` · next ${esc(fmtRelative(job.next_run_at))}` : ''}</div>
          <div class="mt-1.5 flex flex-wrap gap-1">${
            (deliverList(job.deliver).length ? deliverList(job.deliver) : ['local'])
              .map((d) => `<span class="chip pr-2.5">→ ${esc(d)}</span>`).join('')}</div>
        </a>
      </li>`
  }).join('')
}

function detailHeader(job: Job): string {
  const paused = !job.enabled || job.state === 'paused'
  return `
    <div class="flex flex-wrap items-start gap-3">
      <div class="min-w-0">
        <h2 class="text-xl font-semibold tracking-tight">${esc(job.name || job.id)}</h2>
        <p class="mt-1 text-sm text-stone-500">
          <span class="font-mono">${esc(job.id)}</span> · ${esc(scheduleText(job))}
          ${paused ? ' · paused' : job.next_run_at ? ` · next run ${esc(fmtDate(job.next_run_at))}` : ''}
        </p>
        <p class="mt-0.5 text-sm text-stone-500">Last run: ${esc(fmtDate(job.last_run_at))}${
          job.last_status ? ` (${esc(job.last_status)})` : ''} · ${job.repeat.completed} completed</p>
        <p class="mt-0.5 text-sm text-stone-500">Model: ${job.model
          ? `<span class="font-mono">${esc(job.model)}</span> (pinned)`
          : `<span class="font-mono">${esc(state.meta?.defaultModel ?? 'default')}</span> (follows your default)`}</p>
      </div>
      <div class="ml-auto flex gap-2">
        <button type="button" class="btn" data-action="run" title="Run on the next scheduler tick">Run now</button>
        <button type="button" class="btn" data-action="${paused ? 'resume' : 'pause'}">${paused ? 'Resume' : 'Pause'}</button>
        <button type="button" class="btn btn-danger" data-action="delete">Delete</button>
      </div>
    </div>`
}

function renderDetail() {
  if (!state.meta) return
  if (state.selected === 'settings') {
    renderSettings(detailEl, toast).catch((err) => {
      detailEl.innerHTML = `<div class="p-6"><p class="error-box">${esc(err instanceof Error ? err.message : err)}</p></div>`
    })
    return
  }
  if (state.selected === 'new') {
    detailEl.innerHTML = `
      <div class="mx-auto max-w-3xl p-6">
        <h2 class="mb-6 text-xl font-semibold tracking-tight">New job</h2>
        <div data-body></div>
      </div>`
    renderJobForm($('[data-body]', detailEl), null, state.meta, state.models, formCallbacks)
    return
  }

  const job = currentJob()
  if (!job) {
    detailEl.innerHTML = `
      <div class="grid h-full place-items-center p-6 text-center text-sm text-stone-500">
        <p>${state.selected ? 'That job no longer exists.' : 'Select a job, or create a new one.'}</p>
      </div>`
    return
  }

  detailEl.innerHTML = `
    <div class="mx-auto max-w-4xl p-6">
      <div data-header>${detailHeader(job)}</div>
      <nav class="mt-6 mb-6 flex gap-5 border-b border-stone-200 dark:border-stone-800" role="tablist">
        ${TABS.map(([t, label]) => `
          <a role="tab" class="tab" aria-selected="${t === state.tab}"
            href="#/${esc(job.id)}${t === 'settings' ? '' : `/${t}`}">${label}</a>`).join('')}
      </nav>
      <div data-body></div>
    </div>`

  const body = $('[data-body]', detailEl)
  const fail = (err: unknown) => { body.innerHTML = `<p class="error-box">${esc(err instanceof Error ? err.message : err)}</p>` }
  if (state.tab === 'settings') renderJobForm(body, job, state.meta, state.models, formCallbacks)
  else if (state.tab === 'runs') renderRuns(body, job.id).catch(fail)
  else renderOutputs(body, job.id).catch(fail)
}

const formCallbacks = {
  async onSaved(output: string, created: boolean) {
    const before = new Set(state.jobs.map((j) => j.id))
    await refresh()
    toast(output || 'Saved.')
    if (created) {
      const added = state.jobs.find((j) => !before.has(j.id))
      navigate(added?.id ?? null)
    } else {
      renderDetail()
    }
  },
  onCancel() {
    state.dirty = false
    if (state.selected === 'new') navigate(null)
    else renderDetail()
  },
  onDirty(dirty: boolean) { state.dirty = dirty },
}

// --- Data --------------------------------------------------------------------

async function refresh() {
  const res = await api.jobs()
  state.jobs = res.jobs
  state.heartbeatAgeSec = res.heartbeatAgeSec
  renderStatus()
  renderList()
  // Refresh the header only; re-rendering the form would clobber edits in progress.
  const job = currentJob()
  const header = detailEl.querySelector('[data-header]')
  if (job && header) header.innerHTML = detailHeader(job)
}

let deleteArmed = 0
async function runAction(action: string, btn: HTMLButtonElement) {
  if (action === 'new') return navigate('new')
  const job = currentJob()
  if (!job) return

  if (action === 'delete' && !deleteArmed) {
    // Two-step delete instead of a modal: first click arms, second click (within 4s) deletes.
    btn.textContent = 'Click again to delete'
    deleteArmed = window.setTimeout(() => { deleteArmed = 0; btn.textContent = 'Delete' }, 4000)
    return
  }
  clearTimeout(deleteArmed)
  deleteArmed = 0

  btn.disabled = true
  try {
    const res = action === 'delete'
      ? await api.remove(job.id)
      : await api.action(job.id, action as 'pause' | 'resume' | 'run')
    toast(res.output || (res.ok ? 'Done.' : 'Command failed.'))
    await refresh()
    if (action === 'delete' && res.ok) {
      state.dirty = false
      navigate(null)
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err))
  } finally {
    btn.disabled = false
  }
}

// --- Wiring ------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')
  if (btn) runAction(btn.dataset.action!, btn)
})

window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault() })

window.addEventListener('hashchange', () => {
  const prevSelected = state.selected
  const prevTab = state.tab
  readHash()
  if (state.dirty && prevTab === 'settings' && (state.tab !== prevTab || state.selected !== prevSelected)) {
    if (!confirm('Discard unsaved changes?')) {
      history.replaceState(null, '', `#/${prevSelected ?? ''}`)
      state.selected = prevSelected
      state.tab = prevTab
      return
    }
  }
  state.dirty = false
  renderList()
  renderDetail()
})

// Poll only while the tab is visible, and catch up immediately when it becomes visible.
let pollTimer = 0
function schedulePoll() {
  clearTimeout(pollTimer)
  if (document.visibilityState === 'visible') {
    pollTimer = window.setTimeout(() => refresh().catch(() => {}).finally(schedulePoll), POLL_MS)
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh().catch(() => {})
  schedulePoll()
})

async function init() {
  readHash()
  try {
    // The model list is non-essential: if a provider lookup fails, the picker falls back to "Custom…".
    const [meta, models] = await Promise.all([api.meta(), api.models().catch(() => []), refresh()])
    state.meta = meta
    state.models = models
    renderDetail()
    schedulePoll()
  } catch (err) {
    detailEl.innerHTML = `<div class="p-6"><p class="error-box">Could not load Hermes data: ${
      esc(err instanceof Error ? err.message : err)}</p></div>`
  }
}

init()
