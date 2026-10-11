import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, Trash2 } from 'lucide-react'
import { api, type Application } from '../api/client'

const SOURCE_STYLES: Record<string, string> = {
  rule: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  ai: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  saved: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
  file: 'bg-muted text-muted-foreground',
}
const SOURCE_LABELS: Record<string, string> = { rule: 'Rule', ai: 'AI', saved: 'Saved', file: 'File' }

// Stored as naive UTC by the backend.
const when = (iso: string) =>
  new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

export function Applications() {
  const { data: apps, isLoading } = useQuery({ queryKey: ['applications'], queryFn: api.listApplications })

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center gap-3">
        <Link to="/" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-xl font-bold">Applications</h1>
          <p className="text-xs text-muted-foreground">
            Recorded by the browser extension when a site confirms your submission
            {apps ? ` · ${apps.length} total` : ''}
          </p>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {apps && apps.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          Nothing recorded yet. Submit an application with the extension panel open and it will show up here.
        </p>
      )}
      <div className="space-y-3">
        {(apps || []).map((app) => (
          <ApplicationCard key={app.id} app={app} />
        ))}
      </div>
    </div>
  )
}

function ApplicationCard({ app }: { app: Application }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const del = useMutation({
    mutationFn: () => api.deleteApplication(app.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['applications'] }),
  })
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
          <Chevron className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate font-semibold">{app.title || app.page_title || 'Untitled application'}</p>
            <p className="text-sm capitalize text-muted-foreground">{app.company || 'Unknown company'}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {when(app.applied_at)}
              {app.resume ? ` · ${app.resume}` : ''} · {app.answers.length} field{app.answers.length === 1 ? '' : 's'}
              {app.confirmation === 'manual' ? ' · marked by hand' : ''}
            </p>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <a
            href={app.url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open application page"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <button
            onClick={() => window.confirm('Delete this record?') && del.mutate()}
            aria-label="Delete"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-red-600"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 divide-y divide-border border-t border-border">
          {app.answers.length === 0 && (
            <p className="pt-3 text-sm text-muted-foreground">No form values were captured for this one.</p>
          )}
          {app.answers.map((a, i) => (
            <div key={i} className="flex items-start gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">{a.label}</p>
                <p className="whitespace-pre-wrap break-words text-sm">{a.value}</p>
              </div>
              {a.source && (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    SOURCE_STYLES[a.source] || SOURCE_STYLES.file
                  }`}
                >
                  {SOURCE_LABELS[a.source] || a.source}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
