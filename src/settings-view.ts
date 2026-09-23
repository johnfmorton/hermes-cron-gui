import { api } from './api.ts'
import type { RewriteBackend, SettingsResponse } from './types.ts'
import { $, esc } from './util.ts'

const BACKENDS: [RewriteBackend, string, string][] = [
  ['ollama', 'Local Ollama', 'Free and private; slower, and quality depends on the model.'],
  ['anthropic', 'Anthropic API', 'Uses ANTHROPIC_API_KEY from this project\'s .env file. Billed per request.'],
]

export async function renderSettings(root: HTMLElement, toast: (m: string) => void) {
  root.innerHTML = '<div class="mx-auto max-w-3xl p-6 text-sm text-stone-500">Loading…</div>'
  let data: SettingsResponse = await api.settings()

  root.innerHTML = `
    <div class="mx-auto max-w-3xl space-y-8 p-6">
      <h2 class="text-xl font-semibold tracking-tight">Settings</h2>
      <form class="space-y-5" novalidate>
        <div>
          <h3 class="text-sm font-semibold tracking-wide text-stone-500 uppercase">Prompt rewriter</h3>
          <p class="hint">The model behind "Suggest rewrite" on a job's prompt. This is separate from the model each job runs on.</p>
        </div>
        <fieldset class="space-y-2">
          <legend class="label">Backend</legend>
          ${BACKENDS.map(([value, label, hint]) => `
            <label class="flex items-start gap-2">
              <input type="radio" name="backend" value="${value}" class="mt-1" ${data.settings.rewrite.backend === value ? 'checked' : ''} />
              <span><span class="text-sm font-medium">${label}</span><span class="hint block">${esc(hint)}</span></span>
            </label>`).join('')}
        </fieldset>
        <div data-key-status></div>
        <div>
          <label class="label" for="s-model">Model</label>
          <select id="s-model" name="model" class="input"></select>
          <p class="hint" data-model-hint></p>
        </div>
        <p class="error-box" data-error hidden></p>
        <div class="flex items-center gap-2 border-t border-stone-200 pt-6 dark:border-stone-800">
          <button type="submit" class="btn btn-primary">Save</button>
          <a href="#" class="btn">Back to jobs</a>
        </div>
      </form>
    </div>`

  const form = $<HTMLFormElement>('form', root)
  const select = $<HTMLSelectElement>('[name="model"]', form)
  const modelHint = $('[data-model-hint]', form)
  const errorBox = $('[data-error]', form)
  const saveBtn = $<HTMLButtonElement>('[type="submit"]', form)
  const backend = () => (new FormData(form).get('backend') as RewriteBackend) ?? 'ollama'
  let loadSeq = 0

  function renderKeyStatus() {
    const el = $('[data-key-status]', form)
    if (backend() !== 'anthropic') { el.innerHTML = ''; return }
    el.innerHTML = data.anthropicKeyPresent
      ? '<p class="text-sm text-emerald-700 dark:text-emerald-400">✓ ANTHROPIC_API_KEY found in .env</p>'
      : `<p class="warn">No ANTHROPIC_API_KEY found. Add it to <code class="break-all">${esc(data.envFile)}</code>
          (see <code>.env.example</code>), then choose this option again. The key stays on this machine and is never sent to the browser.</p>`
  }

  async function loadModels() {
    const seq = ++loadSeq
    const b = backend()
    select.disabled = saveBtn.disabled = true
    select.innerHTML = '<option>Loading models…</option>'
    modelHint.textContent = ''
    try {
      const models = await api.rewriteModels(b)
      if (seq !== loadSeq) return
      // Keep the saved choice selected, even if the provider no longer lists it.
      const saved = data.settings.rewrite.backend === b ? data.settings.rewrite.model : ''
      const preferred = saved || (b === 'anthropic' ? 'claude-opus-5' : 'qwen3.8:27b')
      const list = models.includes(preferred) || !saved ? models : [saved, ...models]
      select.innerHTML = list.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
      select.value = list.includes(preferred) ? preferred : list[0] ?? ''
      select.disabled = saveBtn.disabled = !list.length
      if (!list.length) modelHint.textContent = 'No models available.'
    } catch (err) {
      if (seq !== loadSeq) return
      select.innerHTML = ''
      // The missing-key case is already explained above the field.
      const missingKey = b === 'anthropic' && !data.anthropicKeyPresent
      modelHint.textContent = missingKey ? '' : err instanceof Error ? err.message : String(err)
    }
  }

  form.addEventListener('change', async (e) => {
    if ((e.target as HTMLInputElement).name !== 'backend') return
    // Re-check .env so a key added while this page is open is picked up without a reload.
    const { anthropicKeyPresent } = await api.settings()
    data = { ...data, anthropicKeyPresent }
    renderKeyStatus()
    loadModels()
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errorBox.hidden = true
    try {
      data = await api.saveSettings({ rewrite: { backend: backend(), model: select.value } })
      toast(`Rewriter set to ${data.settings.rewrite.model}.`)
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : String(err)
      errorBox.hidden = false
    }
  })

  renderKeyStatus()
  await loadModels()
}
