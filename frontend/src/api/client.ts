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

export interface Slide {
  title: string
  bullets: string[]
  notes: string
}

export interface Deck {
  title: string
  subtitle: string
  slides: Slide[]
  repo?: { full_name: string; url: string }
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

export interface ChatMessage {
  id?: number
  role: 'user' | 'assistant'
  content: string
  audio_url?: string | null
  created_at?: string
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
  chatSessions: (kind?: string) =>
    request<{ id: number; title: string; updated_at: string }[]>(
      `/api/chat/sessions${kind ? `?kind=${kind}` : ''}`
    ),
  chatNewSession: (kind = 'deepdive') =>
    request<{ session_id: number; messages: ChatMessage[] }>(
      `/api/chat/sessions?kind=${kind}`,
      { method: 'POST' }
    ),
  chatGetSession: (id: number) =>
    request<{ session_id: number; messages: ChatMessage[] }>(`/api/chat/sessions/${id}`),
  chatSend: (id: number, message: string) =>
    request<ChatMessage>(`/api/chat/sessions/${id}/message`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  chatExtract: (id: number) =>
    request<{ insights: string }>(`/api/chat/sessions/${id}/extract`, { method: 'POST' }),
  chatDelete: (id: number) =>
    request<{ status: string }>(`/api/chat/sessions/${id}`, { method: 'DELETE' }),
  saveJob: (url: string) =>
    request<{ saved: boolean; duplicate: boolean; id: number | null; title: string; company: string }>(
      '/api/jobs/save',
      { method: 'POST', body: JSON.stringify({ url }) }
    ),
  googleStatus: () => request<{ connected: boolean }>('/api/google/status'),
  generatePresentation: (body: {
    repo_url: string
    reference_slides_url?: string
    reference_text?: string
    target_slides?: number
  }) =>
    request<Deck>('/api/presentation/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createGoogleSlides: (deck: Deck) =>
    request<{ id: string; url: string }>('/api/presentation/google-slides', {
      method: 'POST',
      body: JSON.stringify({ deck }),
    }),
  downloadPptx: async (deck: Deck): Promise<void> => {
    const res = await fetch('/api/presentation/pptx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deck }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(err.detail || 'PPTX export failed')
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = (deck.title || 'presentation').replace(/[^a-z0-9 _-]/gi, '_') + '.pptx'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  },
}
