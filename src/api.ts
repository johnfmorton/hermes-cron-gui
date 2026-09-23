import type { CommandResult, JobInput, JobsResponse, MetaResponse, OutputFile, Run } from './types.ts'

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? res.statusText)
  }
  return res.headers.get('content-type')?.includes('json') ? res.json() : (res.text() as Promise<T>)
}

const job = (id: string) => `/jobs/${encodeURIComponent(id)}`

export const api = {
  jobs: () => request<JobsResponse>('GET', '/jobs'),
  meta: () => request<MetaResponse>('GET', '/meta'),
  create: (input: JobInput) => request<CommandResult>('POST', '/jobs', input),
  edit: (id: string, input: JobInput) => request<CommandResult>('PATCH', job(id), input),
  remove: (id: string) => request<CommandResult>('DELETE', job(id)),
  action: (id: string, action: 'pause' | 'resume' | 'run') =>
    request<CommandResult>('POST', `${job(id)}/${action}`, {}),
  runs: (id: string) => request<Run[]>('GET', `${job(id)}/runs`),
  outputs: (id: string) => request<OutputFile[]>('GET', `${job(id)}/outputs`),
  output: (id: string, name: string) =>
    request<string>('GET', `${job(id)}/outputs/${encodeURIComponent(name)}`),
}
