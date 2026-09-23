import { esc } from './util.ts'

export interface TokenOption { value: string; label: string }
export interface TokenGroup { label: string; options: TokenOption[] }

const CUSTOM = '__custom__'

/**
 * A list of values shown as removable chips, with an "Add…" picker built from
 * option groups plus a free-text "Custom…" entry. Used for delivery targets and skills.
 */
export class TokenField {
  values: string[]

  constructor(
    private el: HTMLElement,
    initial: string[],
    private groups: TokenGroup[],
    private opts: { customPlaceholder: string; emptyText: string; onChange?: () => void },
  ) {
    this.values = [...initial]
    el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-remove], [data-add-custom]')
      if (!btn) return
      if (btn.dataset.remove !== undefined) this.remove(btn.dataset.remove)
      else this.addCustom()
    })
    el.addEventListener('change', (e) => {
      const select = e.target as HTMLSelectElement
      if (!select.matches('select')) return
      if (select.value === CUSTOM) {
        this.custom(true)
      } else if (select.value) {
        this.add(select.value)
      }
      select.value = ''
    })
    el.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).matches('input') && e.key === 'Enter') {
        e.preventDefault()
        this.addCustom()
      }
    })
    this.render()
  }

  private labelFor(value: string): string {
    for (const g of this.groups) for (const o of g.options) if (o.value === value) return o.label
    return value
  }

  private add(value: string) {
    const v = value.trim()
    if (v && !this.values.includes(v)) this.values.push(v)
    this.render()
    this.opts.onChange?.()
  }

  private remove(value: string) {
    this.values = this.values.filter((v) => v !== value)
    this.render()
    this.opts.onChange?.()
  }

  private addCustom() {
    const input = this.el.querySelector<HTMLInputElement>('input')!
    if (input.value.trim()) this.add(input.value)
  }

  private custom(show: boolean) {
    const row = this.el.querySelector<HTMLElement>('[data-custom-row]')!
    row.hidden = !show
    if (show) row.querySelector('input')!.focus()
  }

  private render() {
    const chips = this.values.length
      ? this.values.map((v) => `
          <span class="chip" title="${esc(this.labelFor(v))}">
            ${esc(v)}
            <button type="button" data-remove="${esc(v)}" aria-label="Remove ${esc(v)}"
              class="rounded-full px-1 hover:bg-indigo-200 dark:hover:bg-indigo-800">×</button>
          </span>`).join('')
      : `<span class="text-xs text-stone-500">${esc(this.opts.emptyText)}</span>`

    const groups = this.groups
      .map((g) => {
        const options = g.options.filter((o) => !this.values.includes(o.value))
        if (!options.length) return ''
        return `<optgroup label="${esc(g.label)}">${options
          .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</optgroup>`
      }).join('')

    this.el.innerHTML = `
      <div class="flex min-h-7 flex-wrap items-center gap-1.5">${chips}</div>
      <div class="mt-2 flex flex-wrap gap-2">
        <select class="input w-auto" aria-label="Add">
          <option value="">Add…</option>${groups}<option value="${CUSTOM}">Custom…</option>
        </select>
        <span data-custom-row hidden class="flex gap-2">
          <input class="input w-56 font-mono" placeholder="${esc(this.opts.customPlaceholder)}" />
          <button type="button" class="btn" data-add-custom>Add</button>
        </span>
      </div>`
  }
}
