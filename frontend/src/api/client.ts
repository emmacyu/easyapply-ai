export interface Job {
  id: number
  source: string
  url: string
  title: string
  company: string
  location?: string | null
  is_remote: boolean
  salary_min?: number | null
  salary_max?: number | null
  salary_currency?: string | null
  date_posted?: string | null
  description?: string | null
  score?: number | null
  grade?: string | null
  score_reasons?: Record<string, { score: number; reason: string }> | null
  red_flags?: string[] | null
  resume_path?: string | null
  cover_letter_path?: string | null
  status: string
  created_at?: string | null
  updated_at?: string | null
}

export interface JobListResponse {
  items: Job[]
  total: number
  page: number
  page_size: number
}

export interface Stats {
  today_new: number
  pending: number
  applied: number
  reply_rate: number
}

export interface PipelineStatus {
  running: boolean
  stage?: string | null
  message?: string | null
  started_at?: string | null
  finished_at?: string | null
  error?: string | null
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Request failed')
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  listJobs: (params: Record<string, string | number>) => {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString()
    return request<JobListResponse>(`/api/jobs?${qs}`)
  },
  getJob: (id: number) => request<Job>(`/api/jobs/${id}`),
  updateStatus: (id: number, status: string) =>
    request<Job>(`/api/jobs/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  getStats: () => request<Stats>('/api/stats'),
  getPipelineStatus: () => request<PipelineStatus>('/api/pipeline/status'),
  runPipeline: () =>
    request<{ status: string }>('/api/pipeline/run', { method: 'POST' }),
  tailorJob: (id: number, kind: 'resume' | 'cover' | 'both' = 'both') =>
    request<{ status: string }>(`/api/jobs/${id}/tailor?kind=${kind}`, {
      method: 'POST',
    }),
  materialsStatus: (id: number) =>
    request<
      Record<string, { state: string; pdf?: boolean; message?: string }>
    >(`/api/jobs/${id}/materials-status`),
  resumeUrl: (id: number, inline = false) =>
    `/api/jobs/${id}/resume${inline ? '?inline=1' : ''}`,
  coverLetterUrl: (id: number, inline = false) =>
    `/api/jobs/${id}/cover-letter${inline ? '?inline=1' : ''}`,
  templateUrl: (kind: 'resume' | 'cover', inline = false) =>
    `/api/templates/${kind}${inline ? '?inline=1' : ''}`,
  jobDiff: (id: number, kind: 'resume' | 'cover') =>
    request<{ segments: { type: 'equal' | 'insert' | 'delete'; text: string }[] }>(
      `/api/jobs/${id}/diff/${kind}`
    ),
  getProfileRaw: () => request<Record<string, any>>('/api/profile/raw'),
  saveProfileRaw: (data: Record<string, any>) =>
    request<Record<string, any>>('/api/profile/raw', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  listAnswers: () =>
    request<
      { key: string; question: string; answer: string; reviewed: number; job_id: number | null }[]
    >('/api/answers'),
  updateAnswer: (key: string, answer: string) =>
    request<{ status: string }>(`/api/answers/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ answer }),
    }),
  deleteAnswer: (key: string) =>
    request<{ status: string }>(`/api/answers/${key}`, { method: 'DELETE' }),
  saveJob: (url: string) =>
    request<{ saved: boolean; duplicate: boolean; id: number | null; title: string; company: string }>(
      '/api/jobs/save',
      { method: 'POST', body: JSON.stringify({ url }) }
    ),
}
