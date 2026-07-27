import { cn } from '../lib/utils'

const gradeStyles: Record<string, string> = {
  A: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  B: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30',
  C: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  D: 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30',
  F: 'bg-slate-500/15 text-slate-500 dark:text-slate-500 border-slate-500/30',
}

interface Props {
  grade?: string | null
  score?: number | null
  className?: string
}

export function ScoreBadge({ grade, score, className }: Props) {
  const g = grade || '?'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        gradeStyles[g] || gradeStyles.F,
        className
      )}
    >
      {g}
      {score != null && <span className="opacity-70">· {score}</span>}
    </span>
  )
}
