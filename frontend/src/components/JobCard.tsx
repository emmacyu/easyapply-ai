import type { Job } from '../api/client'
import { ScoreBadge } from './ScoreBadge'
import { StatusActions } from './StatusActions'
import { cn } from '../lib/utils'
import { MapPin, DollarSign, Calendar } from 'lucide-react'
import { Link } from 'react-router-dom'

interface Props {
  job: Job
  active?: boolean
}

function formatSalary(job: Job) {
  if (!job.salary_min && !job.salary_max) return null
  const cur = job.salary_currency || 'CAD'
  if (job.salary_min && job.salary_max) {
    return `${cur} ${Math.round(job.salary_min / 1000)}k–${Math.round(job.salary_max / 1000)}k`
  }
  return `${cur} ${Math.round((job.salary_min || job.salary_max || 0) / 1000)}k`
}

export function JobCard({ job, active }: Props) {
  const salary = formatSalary(job)

  return (
    <article
      className={cn(
        'rounded-xl border bg-card shadow-sm transition',
        active
          ? 'border-primary ring-1 ring-primary/30'
          : 'border-border hover:border-primary/40'
      )}
    >
      <Link to={`/jobs/${job.id}`} className="block p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3
              className={cn(
                'truncate font-semibold',
                active && 'text-primary'
              )}
            >
              {job.title}
            </h3>
            <p className="truncate text-sm font-medium text-muted-foreground">
              {job.company}
            </p>
          </div>
          <ScoreBadge grade={job.grade} score={job.score} />
        </div>

        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {job.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" />
              {job.location}
              {job.is_remote && ' · Remote'}
            </span>
          )}
          {salary && (
            <span className="inline-flex items-center gap-1">
              <DollarSign className="h-3.5 w-3.5" />
              {salary}
            </span>
          )}
          {job.date_posted && (
            <span className="inline-flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {job.date_posted}
            </span>
          )}
        </div>
      </Link>

      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2">
        <span className="flex items-center gap-1.5">
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
            {job.status.replace('_', ' ')}
          </span>
          {job.source === 'manual' && (
            <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              saved
            </span>
          )}
        </span>
        <StatusActions job={job} compact />
      </div>
    </article>
  )
}
