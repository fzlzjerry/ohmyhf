import type {
  DailyPapersPeriod,
  DailyPapersQuery,
  DailyPapersSort,
  PaperSummary
} from '@oh-my-huggingface/shared'

/** ISO week (`YYYY-Www`) in UTC, matching Hub `daily_papers?week=`. */
export function currentIsoWeek(now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export function currentIsoMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

export function dailyPapersRequest(
  period: DailyPapersPeriod,
  sort: DailyPapersSort,
  cursor?: string,
  now = new Date()
): DailyPapersQuery {
  return {
    cursor,
    period,
    sort,
    week: period === 'weekly' ? currentIsoWeek(now) : undefined,
    month: period === 'monthly' ? currentIsoMonth(now) : undefined
  }
}

export function paperDayKey(iso?: string): string | undefined {
  if (!iso) return undefined
  const day = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined
}

export function formatPaperDay(isoDate: string, locale: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return isoDate
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
}

export function githubRepoUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) return value
  return `https://github.com/${value.replace(/^github\.com\//i, '')}`
}

export function paperMatchesQuery(paper: PaperSummary, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  if (paper.id.toLowerCase().includes(needle) || paper.title.toLowerCase().includes(needle)) {
    return true
  }
  return paper.authors.some((author) => author.toLowerCase().includes(needle))
}

export type PaperListRow = { type: 'day'; day: string } | { type: 'paper'; paper: PaperSummary }

export function groupPapersByDay(papers: PaperSummary[]): PaperListRow[] {
  const rows: PaperListRow[] = []
  let lastDay: string | undefined
  for (const paper of papers) {
    const day = paperDayKey(paper.submittedOnDailyAt ?? paper.publishedAt)
    if (day && day !== lastDay) {
      rows.push({ type: 'day', day })
      lastDay = day
    }
    rows.push({ type: 'paper', paper })
  }
  return rows
}
