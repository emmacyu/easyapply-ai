import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useMatch } from 'react-router-dom'
import {
  Bookmark,
  MessagesSquare,
  Mic,
  MonitorSmartphone,
  Play,
  Search,
  User,
} from 'lucide-react'
import { api } from '../api/client'
import { StatsBar } from './StatsBar'
import { JobCard } from './JobCard'

const STATUS_TABS = [
  { value: '', label: 'All' },
  { value: 'discovered', label: 'Discovered' },
  { value: 'scored', label: 'Scored' },
  { value: 'shortlisted', label: 'Shortlisted' },
  { value: 'materials_ready', label: 'Materials Ready' },
  { value: 'applied', label: 'Applied' },
]

const GRADES = ['A', 'B', 'C', 'D', 'F']

export function JobsLayout() {
  const [status, setStatus] = useState('')
  const [savedOnly, setSavedOnly] = useState(false)
  const [grades, setGrades] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const queryClient = useQueryClient()

  const match = useMatch('/jobs/:id')
  const selectedId = match?.params.id ? Number(match.params.id) : undefined

  const { data, isLoading } = useQuery({
    queryKey: ['jobs', status, savedOnly, grades.join(','), search],
    queryFn: () =>
      api.listJobs({
        status,
        source: savedOnly ? 'manual' : '',
        grade: grades.join(','),
        search,
        sort: 'score',
        page: 1,
        page_size: 50,
      }),
  })

  const pipeline = useMutation({
    mutationFn: api.runPipeline,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pipeline'] }),
  })

  const [saveUrl, setSaveUrl] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const saveJob = useMutation({
    mutationFn: () => api.saveJob(saveUrl.trim()),
    onSuccess: (r) => {
      setSaveMsg(
        r.duplicate
          ? `Already saved: ${r.company} — ${r.title}`
          : `Saved: ${r.company} — ${r.title}`
      )
      setSaveUrl('')
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      setTimeout(() => setSaveMsg(''), 4000)
    },
    onError: (e: any) => setSaveMsg(e.message || 'Save failed'),
  })

  const toggleGrade = (g: string) => {
    setGrades((prev) =>
      prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]
    )
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar */}
      <header className="shrink-0 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">JobPilot</h1>
            <p className="hidden text-xs text-muted-foreground sm:block">
              Discover → Score → Tailor → Apply (human-in-the-loop)
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => pipeline.mutate()}
              disabled={pipeline.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              Run Pipeline
            </button>
            <Link
              to="/deepdive"
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              <MessagesSquare className="h-4 w-4" />
              DeepDive
            </Link>
            <a
              href="/oa"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              <MonitorSmartphone className="h-4 w-4" />
              OA
            </a>
            <Link
              to="/finalroundai"
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              <Mic className="h-4 w-4" />
              FinalRoundAI
            </Link>
            <Link
              to="/profile"
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              <User className="h-4 w-4" />
              Profile
            </Link>
          </div>
        </div>
        <div className="mt-3">
          <StatsBar />
        </div>
      </header>

      {/* Two-pane master/detail */}
      <div className="flex min-h-0 flex-1">
        {/* Left: list */}
        <aside
          className={`${
            selectedId ? 'hidden lg:flex' : 'flex'
          } w-full shrink-0 flex-col border-r border-border lg:w-[400px]`}
        >
          {/* Filters */}
          <div className="shrink-0 space-y-3 border-b border-border p-3">
            {/* Save a job you found while browsing */}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (saveUrl.trim()) saveJob.mutate()
              }}
              className="flex gap-2"
            >
              <input
                value={saveUrl}
                onChange={(e) => setSaveUrl(e.target.value)}
                placeholder="Paste a job URL to save…"
                className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
              />
              <button
                type="submit"
                disabled={saveJob.isPending || !saveUrl.trim()}
                className="shrink-0 rounded-lg bg-muted px-3 py-1.5 text-sm font-medium hover:bg-muted/80 disabled:opacity-50"
              >
                {saveJob.isPending ? 'Saving…' : 'Save'}
              </button>
            </form>
            {saveMsg && <p className="text-xs text-muted-foreground">{saveMsg}</p>}

            <div className="flex flex-wrap gap-1.5">
              {STATUS_TABS.map((tab) => (
                <button
                  key={tab.value}
                  onClick={() => {
                    setStatus(tab.value)
                    setSavedOnly(false)
                  }}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                    !savedOnly && status === tab.value
                      ? 'bg-primary text-white'
                      : 'bg-muted hover:bg-muted/80'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
              <button
                onClick={() => {
                  setSavedOnly(true)
                  setStatus('')
                }}
                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                  savedOnly ? 'bg-primary text-white' : 'bg-muted hover:bg-muted/80'
                }`}
              >
                <Bookmark className="h-3 w-3" />
                Saved
              </button>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search company, title, location..."
                  className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:border-primary"
                />
              </div>
              <div className="flex gap-1">
                {GRADES.map((g) => (
                  <button
                    key={g}
                    onClick={() => toggleGrade(g)}
                    className={`h-8 w-8 rounded-md text-xs font-bold ${
                      grades.includes(g)
                        ? 'bg-primary text-white'
                        : 'bg-muted hover:bg-muted/80'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Scrollable list */}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {isLoading ? (
              <p className="text-center text-sm text-muted-foreground">
                Loading jobs...
              </p>
            ) : data?.items.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                No jobs yet. Run the pipeline to discover opportunities.
              </p>
            ) : (
              <div className="space-y-2">
                {data?.items.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    active={job.id === selectedId}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Right: detail */}
        <main
          className={`${
            selectedId ? 'flex' : 'hidden lg:flex'
          } min-h-0 min-w-0 flex-1 flex-col overflow-y-auto`}
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}
