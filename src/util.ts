import type { Job } from './types.ts'

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
/** Escape text for use inside HTML template strings (content and attribute values). */
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c])

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel)!

export function deliverList(v: Job['deliver'] | undefined): string[] {
  if (!v) return []
  return (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean)
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d)
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return ''
  const sec = (new Date(iso).getTime() - Date.now()) / 1000
  if (!Number.isFinite(sec)) return ''
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86400], ['hour', 3600], ['minute', 60]]
  for (const [unit, size] of units) if (Math.abs(sec) >= size) return rel.format(Math.round(sec / size), unit)
  return rel.format(Math.round(sec), 'second')
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

/** Warnings worth surfacing for a job, in plain language. */
export function jobWarnings(job: Job): string[] {
  const w: string[] = []
  const targets = deliverList(job.deliver)
  if ((targets.length === 0 || targets.includes('origin')) && !job.origin) {
    w.push('Delivers to "origin", but this job has no origin chat (probably created from the CLI), so output is only saved to the log. Choose a real target such as signal.')
  }
  if (job.last_delivery_error) w.push(`Last delivery failed: ${job.last_delivery_error}`)
  if (job.last_status && job.last_status !== 'ok' && job.last_error) w.push(`Last run failed: ${job.last_error}`)
  if (job.failure_streak > 1) w.push(`${job.failure_streak} failures in a row.`)
  return w
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

function describeDow(f: string): string | null {
  if (f === '*') return 'every day'
  if (f === '1-5') return 'weekdays'
  if (f === '0,6' || f === '6,0') return 'weekends'
  const names = f.split(',').map((part) => {
    const [a, b] = part.split('-').map(Number)
    if (!Number.isInteger(a) || a < 0 || a > 7) return null
    if (b === undefined) return DAYS[a % 7]
    return Number.isInteger(b) ? `${DAYS[a % 7]}–${DAYS[b % 7]}` : null
  })
  return names.includes(null) ? null : names.join(', ')
}

/** Best-effort plain-English reading of a Hermes schedule. Returns null if unsure. */
export function describeSchedule(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  let m = s.match(/^every\s+(\d+)\s*([mhd])$/i)
  if (m) return `Every ${m[1]} ${({ m: 'minute', h: 'hour', d: 'day' } as const)[m[2].toLowerCase() as 'm' | 'h' | 'd']}${m[1] === '1' ? '' : 's'}`
  m = s.match(/^(\d+)\s*([mhd])$/i)
  if (m) return `Once, ${m[1]}${m[2].toLowerCase()} after it's saved`
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return `Once, at ${fmtDate(s)}`

  const f = s.split(/\s+/)
  if (f.length !== 5) return null
  const [min, hour, dom, mon, dow] = f
  if (dom !== '*' || mon !== '*') return null
  if ((m = min.match(/^\*\/(\d+)$/)) && hour === '*' && dow === '*') return `Every ${m[1]} minutes`
  if (/^\d+$/.test(min) && hour === '*' && dow === '*') return `Every hour at :${pad(+min)}`
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const days = describeDow(dow)
    if (!days) return null
    const t = new Date(2000, 0, 1, +hour, +min).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    return `${days[0].toUpperCase()}${days.slice(1)} at ${t}`
  }
  return null
}
