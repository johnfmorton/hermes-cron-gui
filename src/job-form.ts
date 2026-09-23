import { api } from './api.ts'
import { TokenField, type TokenGroup } from './token-field.ts'
import type { Job, JobInput, MetaResponse } from './types.ts'
import { $, deliverList, describeSchedule, esc, jobWarnings } from './util.ts'

const SCHEDULE_PRESETS: [string, string][] = [
  ['*/30 * * * *', 'Every 30 min'],
  ['0 * * * *', 'Hourly'],
  ['0 9 * * *', 'Daily 9 AM'],
  ['0 9 * * 1-5', 'Weekdays 9 AM'],
  ['0 8 * * 1', 'Mondays 8 AM'],
  ['every 6h', 'Every 6h'],
  ['30m', 'Once, in 30 min'],
]

const REASONING = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const SILENT_RULE = 'If there is genuinely nothing new to report, respond with only [SILENT].'

function deliverGroups(meta: MetaResponse): TokenGroup[] {
  return [
    {
      label: 'Special',
      options: [
        { value: 'local', label: 'local — save to the output log only' },
        { value: 'origin', label: 'origin — the chat that created the job' },
        { value: 'all', label: 'all — every platform with a home channel' },
        { value: 'bot-chat', label: "bot-chat — inject into the bot's own chat" },
      ],
    },
    {
      label: 'Known chats',
      options: meta.channels.map((c) => ({
        value: `${c.platform}:${c.id}`,
        label: `${c.name} (${c.platform}${c.type ? ` ${c.type}` : ''})`,
      })),
    },
    {
      label: 'Platform home channel',
      options: meta.platforms.map((p) => ({ value: p, label: p })),
    },
  ]
}

/** Values the form edits, normalized so they can be diffed against the original job. */
function initialValues(job: Job | null): Required<Omit<JobInput, 'paused'>> {
  return {
    name: job?.name ?? '',
    schedule: job ? (job.schedule.expr ?? job.schedule.display ?? job.schedule_display ?? '') : '',
    prompt: (job?.prompt ?? '').trim(),
    deliver: job ? deliverList(job.deliver).join(',') : 'signal',
    failureDeliver: job?.failure_deliver ?? '',
    repeat: job?.repeat.times ?? null,
    skills: job?.skills ?? [],
    continuity: job ? (job.context_from ?? []).includes('self') : false,
    noAgent: job?.no_agent ?? false,
    script: job?.script ?? '',
    monitorScript: job?.monitor_script ?? '',
    monitorUrl: job?.monitor_url ?? '',
    workdir: job?.workdir ?? '',
    model: job?.model ?? '',
    provider: job?.provider ?? '',
    reasoningEffort: job?.reasoning_effort ?? '',
  }
}

export interface FormCallbacks {
  onSaved: (output: string, created: boolean) => void
  onCancel: () => void
  onDirty: (dirty: boolean) => void
}

export function renderJobForm(root: HTMLElement, job: Job | null, meta: MetaResponse, cb: FormCallbacks) {
  const init = initialValues(job)
  const warnings = job ? jobWarnings(job) : []
  const text = (name: string, value: string, attrs = '') =>
    `<input ${attrs.includes('class=') ? '' : 'class="input"'} name="${name}" value="${esc(value)}" ${attrs} />`

  root.innerHTML = `
    <form class="space-y-8" novalidate>
      ${warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}

      <section class="space-y-5">
        <div>
          <label class="label" for="f-name">Name</label>
          ${text('name', init.name, 'id="f-name" placeholder="CT election law watch"')}
        </div>

        <div>
          <label class="label" for="f-schedule">Schedule</label>
          ${text('schedule', init.schedule, 'id="f-schedule" class="input font-mono" placeholder="0 8 * * 1" required')}
          <p class="hint" data-schedule-hint></p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            ${SCHEDULE_PRESETS.map(([v, l]) =>
              `<button type="button" class="btn px-2 py-0.5 text-xs" data-schedule="${esc(v)}">${esc(l)}</button>`).join('')}
          </div>
          <p class="hint">Cron expression (<code>0 9 * * 1-5</code>), interval (<code>every 6h</code>),
            one-shot delay (<code>30m</code>), or ISO time. Natural language like "daily at 9am" is not supported.</p>
        </div>

        <div>
          <div class="mb-1 flex items-end justify-between gap-2">
            <label class="label mb-0" for="f-prompt">Prompt</label>
            <button type="button" class="text-xs text-indigo-600 hover:underline dark:text-indigo-400" data-insert-silent>
              Add [SILENT] rule</button>
          </div>
          <textarea id="f-prompt" name="prompt" rows="14" class="input font-mono text-[13px] leading-relaxed"
            placeholder="Self-contained instructions: task, sources (with URLs), output format…">${esc(init.prompt)}</textarea>
          <p class="hint">Each run starts a fresh session with no chat memory, so include everything the job needs.
            The agent's final message is what gets delivered.</p>
        </div>
      </section>

      <section class="space-y-5 border-t border-stone-200 pt-6 dark:border-stone-800">
        <h3 class="text-sm font-semibold tracking-wide text-stone-500 uppercase">Where output goes</h3>
        <div>
          <span class="label">Deliver to</span>
          <div data-field="deliver"></div>
          <p class="hint">Multiple targets are delivered to each. Every run is also saved to the output log.</p>
        </div>
        <div>
          <span class="label">Failure notices to</span>
          <div data-field="failureDeliver"></div>
          <p class="hint">Leave empty to follow "Deliver to". Choose <code>local</code> to keep failure notices out of chat.</p>
        </div>
      </section>

      <details class="group border-t border-stone-200 pt-6 dark:border-stone-800" ${job && hasAdvanced(init) ? 'open' : ''}>
        <summary class="cursor-pointer text-sm font-semibold tracking-wide text-stone-500 uppercase">Advanced</summary>
        <div class="mt-5 grid gap-5 sm:grid-cols-2">
          <label class="flex items-start gap-2 sm:col-span-2">
            <input type="checkbox" name="continuity" class="mt-1" ${init.continuity ? 'checked' : ''} />
            <span><span class="text-sm font-medium">Continuity</span>
              <span class="hint block">Each run sees its previous output, so it can report only what's new.</span></span>
          </label>
          <div class="sm:col-span-2">
            <span class="label">Skills</span>
            <div data-field="skills"></div>
          </div>
          <div><label class="label" for="f-model">Model</label>
            ${text('model', init.model, 'id="f-model" placeholder="Follow default"')}</div>
          <div><label class="label" for="f-provider">Provider</label>
            ${text('provider', init.provider, 'id="f-provider" placeholder="e.g. openrouter"')}</div>
          <div><label class="label" for="f-reasoning">Reasoning effort</label>
            <select id="f-reasoning" name="reasoningEffort" class="input">
              ${REASONING.map((r) => `<option value="${r}" ${r === init.reasoningEffort ? 'selected' : ''}>${r || 'Follow config'}</option>`).join('')}
            </select></div>
          <div><label class="label" for="f-repeat">Repeat count</label>
            <input id="f-repeat" name="repeat" type="number" min="1" class="input" value="${init.repeat ?? ''}" placeholder="Forever" /></div>
          <div class="sm:col-span-2"><label class="label" for="f-workdir">Working directory</label>
            ${text('workdir', init.workdir, 'id="f-workdir" class="input font-mono" placeholder="/absolute/path"')}
            <p class="hint">Loads AGENTS.md / CLAUDE.md from there and uses it as the cwd for tools.</p></div>
          <div class="sm:col-span-2"><label class="label" for="f-script">Script</label>
            ${text('script', init.script, 'id="f-script" class="input font-mono" placeholder="Under ~/.hermes/scripts/"')}
            <label class="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" name="noAgent" ${init.noAgent ? 'checked' : ''} />
              No agent: deliver the script's stdout directly, skip the LLM</label></div>
          <div><label class="label" for="f-monitor-script">Monitor script</label>
            ${text('monitorScript', init.monitorScript, 'id="f-monitor-script" class="input font-mono"')}</div>
          <div><label class="label" for="f-monitor-url">Monitor URL</label>
            ${text('monitorUrl', init.monitorUrl, 'id="f-monitor-url" class="input font-mono" placeholder="https://…"')}</div>
          <p class="hint sm:col-span-2 -mt-3">Monitor mode runs the agent only when the script output or URL content changes.</p>
          ${job ? '' : `
          <label class="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="paused" /> Create paused</label>`}
        </div>
      </details>

      <p class="error-box" data-form-error hidden></p>
      <div class="flex items-center gap-2 border-t border-stone-200 pt-6 dark:border-stone-800">
        <button type="submit" class="btn btn-primary">${job ? 'Save changes' : 'Create job'}</button>
        <button type="button" class="btn" data-cancel>${job ? 'Revert' : 'Cancel'}</button>
        <span class="text-xs text-stone-500" data-dirty></span>
      </div>
    </form>`

  const form = $<HTMLFormElement>('form', root)
  const onChange = () => updateDirty()

  const deliver = new TokenField($('[data-field="deliver"]', root), deliverList(init.deliver), deliverGroups(meta), {
    customPlaceholder: 'telegram:123456789', emptyText: 'Nothing selected (saves to the log only)', onChange,
  })
  const failureDeliver = new TokenField($('[data-field="failureDeliver"]', root), deliverList(init.failureDeliver),
    deliverGroups(meta), { customPlaceholder: 'signal', emptyText: 'Same as "Deliver to"', onChange })
  const skills = new TokenField($('[data-field="skills"]', root), init.skills,
    [{ label: 'Installed skills', options: meta.skills.map((s) => ({ value: s, label: s })) }],
    { customPlaceholder: 'skill-name', emptyText: 'No skills attached', onChange })

  const scheduleInput = $<HTMLInputElement>('[name="schedule"]', form)
  const scheduleHint = $('[data-schedule-hint]', root)
  const updateScheduleHint = () => {
    const d = describeSchedule(scheduleInput.value)
    scheduleHint.textContent = d ?? ''
    scheduleHint.hidden = !d
  }
  updateScheduleHint()

  function current(): Required<Omit<JobInput, 'paused'>> {
    const f = new FormData(form)
    const str = (k: string) => String(f.get(k) ?? '').trim()
    const repeat = str('repeat')
    return {
      name: str('name'),
      schedule: str('schedule'),
      prompt: String(f.get('prompt') ?? '').trim(),
      deliver: deliver.values.join(','),
      failureDeliver: failureDeliver.values.join(','),
      repeat: repeat ? Number(repeat) : null,
      skills: [...skills.values],
      continuity: f.has('continuity'),
      noAgent: f.has('noAgent'),
      script: str('script'),
      monitorScript: str('monitorScript'),
      monitorUrl: str('monitorUrl'),
      workdir: str('workdir'),
      model: str('model'),
      provider: str('provider'),
      reasoningEffort: str('reasoningEffort'),
    }
  }

  function changes(): JobInput {
    const now = current()
    const diff: JobInput = {}
    for (const k of Object.keys(now) as (keyof typeof now)[]) {
      if (JSON.stringify(now[k]) !== JSON.stringify(init[k])) (diff as any)[k] = now[k]
    }
    return diff
  }

  function updateDirty() {
    const n = Object.keys(changes()).length
    $('[data-dirty]', root).textContent = job && n ? `${n} unsaved change${n === 1 ? '' : 's'}` : ''
    cb.onDirty(n > 0)
  }

  form.addEventListener('input', (e) => {
    if (e.target === scheduleInput) updateScheduleHint()
    updateDirty()
  })
  form.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const preset = t.closest<HTMLElement>('[data-schedule]')
    if (preset) {
      scheduleInput.value = preset.dataset.schedule!
      updateScheduleHint()
      updateDirty()
    } else if (t.closest('[data-insert-silent]')) {
      const ta = $<HTMLTextAreaElement>('[name="prompt"]', form)
      if (!ta.value.includes('[SILENT]')) ta.value = `${ta.value.trimEnd()}\n\n${SILENT_RULE}`.trimStart()
      updateDirty()
    } else if (t.closest('[data-cancel]')) {
      cb.onCancel()
    }
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const errorBox = $('[data-form-error]', root)
    errorBox.hidden = true
    const submit = $<HTMLButtonElement>('[type="submit"]', form)

    let payload: JobInput
    if (job) {
      payload = changes()
      if (!Object.keys(payload).length) return
      // An emptied target list means "log only"; say so explicitly rather than sending "".
      if (payload.deliver === '') payload.deliver = 'local'
    } else {
      payload = { ...current(), paused: new FormData(form).has('paused') }
      if (!payload.schedule) {
        errorBox.textContent = 'Schedule is required.'
        errorBox.hidden = false
        return
      }
    }

    submit.disabled = true
    try {
      const res = job ? await api.edit(job.id, payload) : await api.create(payload)
      if (!res.ok) throw new Error(res.output || 'Hermes rejected the change.')
      cb.onDirty(false)
      cb.onSaved(res.output, !job)
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : String(err)
      errorBox.hidden = false
    } finally {
      submit.disabled = false
    }
  })
}

function hasAdvanced(v: ReturnType<typeof initialValues>): boolean {
  return Boolean(v.skills.length || v.model || v.provider || v.reasoningEffort || v.repeat || v.workdir
    || v.script || v.noAgent || v.monitorScript || v.monitorUrl)
}
