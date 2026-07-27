interface DimensionScore {
  score: number
  reason: string
}

interface Props {
  reasons?: Record<string, DimensionScore> | null
}

const labels: Record<string, string> = {
  skill_match: 'Skill Match',
  experience_level: 'Experience Level',
  title_alignment: 'Title Alignment',
  salary_fit: 'Salary Fit',
  location_remote: 'Location / Remote',
  visa_feasibility: 'Visa Feasibility',
  company_signal: 'Company Signal',
  growth_potential: 'Growth Potential',
  jd_quality: 'JD Quality',
  red_flags: 'Red Flags',
}

export function ScoreBreakdown({ reasons }: Props) {
  if (!reasons || Object.keys(reasons).length === 0) {
    return <p className="text-sm text-muted-foreground">No score breakdown yet.</p>
  }

  return (
    <div className="space-y-4">
      {Object.entries(reasons).map(([key, val]) => (
        <div key={key}>
          <div className="mb-1 flex justify-between text-sm">
            <span className="font-medium">{labels[key] || key}</span>
            <span>{val.score}/100</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(100, val.score)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{val.reason}</p>
        </div>
      ))}
    </div>
  )
}
