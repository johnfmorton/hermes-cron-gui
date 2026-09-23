// Shapes shared by the browser UI and the local API (server/hermes-api.ts).
// `Job` mirrors the fields we use from ~/.hermes/cron/jobs.json; Hermes may add more.

export interface Job {
  id: string
  name: string | null
  prompt: string
  skills: string[]
  model: string | null
  provider: string | null
  model_snapshot?: string | null
  reasoning_effort?: string | null
  script: string | null
  no_agent: boolean
  monitor_script: string | null
  monitor_url: string | null
  context_from: string[] | null
  schedule: { kind: string; expr?: string; display?: string }
  schedule_display: string
  repeat: { times: number | null; completed: number }
  enabled: boolean
  state: string
  paused_at: string | null
  paused_reason: string | null
  created_at: string
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
  last_delivery_error: string | null
  failure_streak: number
  deliver: string | string[] | null
  failure_deliver?: string | null
  origin: unknown
  workdir: string | null
}

export interface JobsResponse {
  jobs: Job[]
  updatedAt: string | null
  /** Seconds since the scheduler ticker last wrote its heartbeat; null if unknown. */
  heartbeatAgeSec: number | null
}

export interface Channel {
  platform: string
  id: string
  name: string
  type: string
}

export interface MetaResponse {
  hermesHome: string
  platforms: string[]
  channels: Channel[]
  skills: string[]
}

export interface Run {
  id: string
  job_id: string
  source: string
  status: string
  claimed_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  delivery_outcome: string | null
}

export interface OutputFile {
  name: string
  size: number
  failed: boolean
}

/** Body for create (all fields) and edit (only changed fields). Empty string = clear. */
export interface JobInput {
  schedule?: string
  prompt?: string
  name?: string
  deliver?: string
  failureDeliver?: string
  repeat?: number | null
  skills?: string[]
  script?: string
  noAgent?: boolean
  continuity?: boolean
  monitorScript?: string
  monitorUrl?: string
  workdir?: string
  model?: string
  provider?: string
  reasoningEffort?: string
  paused?: boolean
}

export interface CommandResult {
  ok: boolean
  output: string
}
