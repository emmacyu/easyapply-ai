import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import { AlertTriangle, ArrowLeft, Download, ExternalLink, Eye, GitCompare, RefreshCw, Sparkles, X } from 'lucide-react'
import { api } from '../api/client'
import { ScoreBadge } from '../components/ScoreBadge'
import { ScoreBreakdown } from '../components/ScoreBreakdown'
import { StatusActions } from '../components/StatusActions'

export function JobDetail() {
  const { id } = useParams<{ id: string }>()
  const jobId = Number(id)

  // Generation runs as a background task, so we watch `updated_at` to know when
  // a freshly generated (or regenerated) file has actually landed.
  const [resumePendingSince, setResumePendingSince] = useState<string | null>(null)
  const [coverPendingSince, setCoverPendingSince] = useState<string | null>(null)
  const [preview, setPreview] = useState<{
    title: string
    tailoredUrl: string
    download: string
    originalUrl?: string
    kind?: 'resume' | 'cover'
  } | null>(null)
  const [compareMode, setCompareMode] = useState<'pdf' | 'diff'>('pdf')

  useEffect(() => {
    if (!preview) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPreview(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  const { data: diff, isLoading: diffLoading } = useQuery({
    queryKey: ['diff', jobId, preview?.kind],
    queryFn: () => api.jobDiff(jobId, preview!.kind!),
    enabled: !!preview?.originalUrl && !!preview?.kind && compareMode === 'diff',
  })

  const openCompare = (p: {
    title: string
    tailoredUrl: string
    download: string
    originalUrl: string
    kind: 'resume' | 'cover'
  }) => {
    setCompareMode('pdf')
    setPreview(p)
  }

  const { data: job, isLoading } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.getJob(jobId),
    enabled: !!jobId,
    refetchInterval: () =>
      resumePendingSince !== null || coverPendingSince !== null ? 2500 : false,
  })

  // Outcome of the most recent generation (tailored | fallback | error), so we
  // can tell the user when the AI was unavailable and the template was used.
  const { data: matStatus } = useQuery({
    queryKey: ['mat-status', jobId],
    queryFn: () => api.materialsStatus(jobId),
    enabled: !!jobId,
    refetchInterval: () =>
      resumePendingSince !== null || coverPendingSince !== null ? 2000 : false,
  })

  const resumeGen = useMutation({
    mutationFn: () => api.tailorJob(jobId, 'resume'),
    onSuccess: () => setResumePendingSince(job?.updated_at ?? 'pending'),
  })
  const coverGen = useMutation({
    mutationFn: () => api.tailorJob(jobId, 'cover'),
    onSuccess: () => setCoverPendingSince(job?.updated_at ?? 'pending'),
  })

  // Clear the "generating" state once the document's timestamp advances.
  useEffect(() => {
    if (!job) return
    if (resumePendingSince !== null && job.resume_path && job.updated_at !== resumePendingSince) {
      setResumePendingSince(null)
    }
    if (coverPendingSince !== null && job.cover_letter_path && job.updated_at !== coverPendingSince) {
      setCoverPendingSince(null)
    }
  }, [job, resumePendingSince, coverPendingSince])

  const resumeBusy = resumeGen.isPending || resumePendingSince !== null
  const coverBusy = coverGen.isPending || coverPendingSince !== null
  const isPdf = (p?: string | null) => !!p && p.toLowerCase().endsWith('.pdf')

  const renderNote = (
    outcome?: { state: string; pdf?: boolean; message?: string },
    label = 'document'
  ) => {
    if (!outcome) return null
    const warn =
      'flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300'
    const err =
      'flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300'
    if (outcome.state === 'fallback') {
      return (
        <p className={warn}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          AI tailoring was unavailable (quota exhausted or error). This is your
          original template — <b>not</b> tailored to this job.
        </p>
      )
    }
    if (outcome.state === 'error') {
      return (
        <p className={err}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Failed to generate {label}
          {outcome.message ? `: ${outcome.message}` : ''}.
        </p>
      )
    }
    if (outcome.state === 'tailored' && outcome.pdf === false) {
      return (
        <p className={warn}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Tailored, but the PDF failed to compile — a .tex source is provided
          instead.
        </p>
      )
    }
    return null
  }

  if (isLoading || !job) {
    return (
      <div className="p-6 text-center text-muted-foreground">Loading...</div>
    )
  }

  return (
    <div className="w-full p-6">
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden"
      >
        <ArrowLeft className="h-4 w-4" /> Back to list
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{job.title}</h1>
          <p className="text-lg text-muted-foreground">{job.company}</p>
          <p className="text-sm text-muted-foreground">
            {job.location}
            {job.is_remote && ' · Remote'} · {job.source}
          </p>
        </div>
        <ScoreBadge grade={job.grade} score={job.score} className="text-sm px-3 py-1" />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-3 font-semibold">Job Description</h2>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown>{job.description || '_No description available._'}</ReactMarkdown>
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-3 font-semibold">Score Breakdown</h2>
            <ScoreBreakdown reasons={job.score_reasons} />
          </section>

          {job.red_flags && job.red_flags.length > 0 && (
            <section className="rounded-xl border border-red-500/30 bg-red-500/5 p-5">
              <h2 className="mb-2 font-semibold text-red-600 dark:text-red-400">
                Red Flags
              </h2>
              <ul className="list-inside list-disc text-sm">
                {job.red_flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-3 font-semibold">Materials</h2>
            <div className="space-y-4">
              {/* Resume */}
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Resume
                </p>
                {resumeBusy ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse">
                    <RefreshCw className="h-4 w-4 animate-spin" /> Generating resume...
                  </p>
                ) : job.resume_path ? (
                  <div className="space-y-2">
                    {isPdf(job.resume_path) && (
                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            setPreview({
                              title: 'Résumé',
                              tailoredUrl: api.resumeUrl(job.id, true),
                              download: api.resumeUrl(job.id),
                            })
                          }
                          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                        >
                          <Eye className="h-4 w-4" /> Preview
                        </button>
                        <button
                          onClick={() =>
                            openCompare({
                              title: 'Résumé — Original vs Tailored',
                              tailoredUrl: api.resumeUrl(job.id, true),
                              download: api.resumeUrl(job.id),
                              originalUrl: api.templateUrl('resume', true),
                              kind: 'resume',
                            })
                          }
                          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                        >
                          <GitCompare className="h-4 w-4" /> Compare
                        </button>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <a
                        href={api.resumeUrl(job.id)}
                        className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                      >
                        <Download className="h-4 w-4" /> Download
                      </a>
                      <button
                        onClick={() => resumeGen.mutate()}
                        className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm hover:bg-muted/80"
                      >
                        <RefreshCw className="h-4 w-4" /> Regenerate
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => resumeGen.mutate()}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90"
                  >
                    <Sparkles className="h-4 w-4" /> Generate Resume
                  </button>
                )}
                {!resumeBusy && renderNote(matStatus?.resume, 'resume')}
              </div>

              {/* Cover letter */}
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Cover Letter
                </p>
                {coverBusy ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse">
                    <RefreshCw className="h-4 w-4 animate-spin" /> Generating cover letter...
                  </p>
                ) : job.cover_letter_path ? (
                  <div className="space-y-2">
                    {isPdf(job.cover_letter_path) && (
                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            setPreview({
                              title: 'Cover Letter',
                              tailoredUrl: api.coverLetterUrl(job.id, true),
                              download: api.coverLetterUrl(job.id),
                            })
                          }
                          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                        >
                          <Eye className="h-4 w-4" /> Preview
                        </button>
                        <button
                          onClick={() =>
                            openCompare({
                              title: 'Cover Letter — Original vs Tailored',
                              tailoredUrl: api.coverLetterUrl(job.id, true),
                              download: api.coverLetterUrl(job.id),
                              originalUrl: api.templateUrl('cover', true),
                              kind: 'cover',
                            })
                          }
                          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                        >
                          <GitCompare className="h-4 w-4" /> Compare
                        </button>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <a
                        href={api.coverLetterUrl(job.id)}
                        className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                      >
                        <Download className="h-4 w-4" /> Download
                      </a>
                      <button
                        onClick={() => coverGen.mutate()}
                        className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm hover:bg-muted/80"
                      >
                        <RefreshCw className="h-4 w-4" /> Regenerate
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => coverGen.mutate()}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90"
                  >
                    <Sparkles className="h-4 w-4" /> Generate Cover Letter
                  </button>
                )}
                {!coverBusy && renderNote(matStatus?.cover, 'cover letter')}
              </div>
            </div>
          </section>

          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-white hover:opacity-90"
          >
            <ExternalLink className="h-4 w-4" /> Open Application Page
          </a>

          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-3 font-semibold">Status</h2>
            <p className="mb-3 text-sm capitalize text-muted-foreground">
              Current: {job.status.replace('_', ' ')}
            </p>
            <StatusActions job={job} />
          </section>
        </aside>
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/70 p-3 sm:p-6"
          onClick={() => setPreview(null)}
        >
          <div
            className={`mx-auto flex h-full w-full flex-col overflow-hidden rounded-xl bg-card shadow-2xl ${
              preview.originalUrl ? 'max-w-6xl' : 'max-w-4xl'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
              <h3 className="font-semibold">{preview.title}</h3>
              <div className="flex items-center gap-4">
                {preview.originalUrl && (
                  <div className="flex rounded-lg bg-muted p-0.5 text-xs font-medium">
                    <button
                      onClick={() => setCompareMode('pdf')}
                      className={`rounded-md px-2.5 py-1 ${compareMode === 'pdf' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
                    >
                      Side-by-side
                    </button>
                    <button
                      onClick={() => setCompareMode('diff')}
                      className={`rounded-md px-2.5 py-1 ${compareMode === 'diff' ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
                    >
                      Highlight diff
                    </button>
                  </div>
                )}
                <a
                  href={preview.download}
                  className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  <Download className="h-4 w-4" /> Download tailored
                </a>
                <button
                  onClick={() => setPreview(null)}
                  aria-label="Close preview"
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            {!preview.originalUrl ? (
              <iframe
                src={preview.tailoredUrl}
                title={preview.title}
                className="h-full w-full flex-1 bg-white"
              />
            ) : compareMode === 'pdf' ? (
              <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                <div className="flex min-h-0 flex-1 flex-col border-b border-border md:border-b-0 md:border-r">
                  <div className="shrink-0 bg-muted px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Original template
                  </div>
                  <iframe
                    src={preview.originalUrl}
                    title="Original"
                    className="min-h-0 w-full flex-1 bg-white"
                  />
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="shrink-0 bg-primary/10 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-primary">
                    Tailored to this job
                  </div>
                  <iframe
                    src={preview.tailoredUrl}
                    title="Tailored"
                    className="min-h-0 w-full flex-1 bg-white"
                  />
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center gap-4 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-3 w-3 rounded-sm bg-green-500/30" /> added
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-3 w-3 rounded-sm bg-red-500/30" /> removed
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-5 text-sm leading-relaxed">
                  {diffLoading || !diff ? (
                    <p className="text-muted-foreground">Computing diff…</p>
                  ) : (
                    diff.segments.map((s, i) =>
                      s.type === 'equal' ? (
                        <span key={i}>{s.text}</span>
                      ) : s.type === 'insert' ? (
                        <span key={i} className="rounded bg-green-500/20 text-green-800 dark:text-green-300">
                          {s.text}
                        </span>
                      ) : (
                        <span key={i} className="rounded bg-red-500/20 text-red-800 line-through dark:text-red-300">
                          {s.text}
                        </span>
                      )
                    )
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
