import { describe, expect, it } from 'vitest'
import type { PaperSummary } from '@oh-my-huggingface/shared'
import {
  currentIsoMonth,
  currentIsoWeek,
  dailyPapersRequest,
  githubRepoUrl,
  groupPapersByDay,
  paperDayKey,
  paperMatchesQuery
} from './paper-periods'

function paper(partial: Partial<PaperSummary> & Pick<PaperSummary, 'id' | 'title'>): PaperSummary {
  return {
    summary: '',
    upvotes: 0,
    authors: [],
    ...partial
  }
}

describe('paper periods', () => {
  it('formats the ISO week and month Hub expects', () => {
    const date = new Date('2026-01-07T12:00:00Z')
    expect(currentIsoWeek(date)).toBe('2026-W02')
    expect(currentIsoMonth(date)).toBe('2026-01')
  })

  it('adds week or month only for the matching period', () => {
    const now = new Date('2026-08-24T00:00:00Z')
    expect(dailyPapersRequest('daily', 'trending', undefined, now)).toEqual({
      cursor: undefined,
      period: 'daily',
      sort: 'trending',
      week: undefined,
      month: undefined
    })
    expect(dailyPapersRequest('weekly', 'publishedAt', undefined, now).week).toBe('2026-W35')
    expect(dailyPapersRequest('monthly', 'publishedAt', undefined, now).month).toBe('2026-08')
  })

  it('keeps a full GitHub URL and expands owner/repo', () => {
    expect(githubRepoUrl('https://github.com/org/repo')).toBe('https://github.com/org/repo')
    expect(githubRepoUrl('MoonshotAI/Attention-Residuals')).toBe(
      'https://github.com/MoonshotAI/Attention-Residuals'
    )
  })

  it('extracts a calendar day from timestamps', () => {
    expect(paperDayKey('2026-08-24T10:00:00.000Z')).toBe('2026-08-24')
    expect(paperDayKey('not-a-date')).toBeUndefined()
  })

  it('filters papers by title, author, or arXiv id', () => {
    const item = paper({
      id: '2401.00001',
      title: 'Attention Is Still All You Need',
      authors: ['A. Researcher']
    })
    expect(paperMatchesQuery(item, 'attention')).toBe(true)
    expect(paperMatchesQuery(item, '2401')).toBe(true)
    expect(paperMatchesQuery(item, 'researcher')).toBe(true)
    expect(paperMatchesQuery(item, 'diffusion')).toBe(false)
  })

  it('inserts a day label when the calendar day changes', () => {
    const rows = groupPapersByDay([
      paper({
        id: '1',
        title: 'One',
        submittedOnDailyAt: '2026-08-24T10:00:00.000Z'
      }),
      paper({
        id: '2',
        title: 'Two',
        publishedAt: '2026-08-24T18:00:00.000Z'
      }),
      paper({
        id: '3',
        title: 'Three',
        publishedAt: '2026-08-23T09:00:00.000Z'
      })
    ])
    expect(rows.map((row) => (row.type === 'day' ? row.day : row.paper.id))).toEqual([
      '2026-08-24',
      '1',
      '2',
      '2026-08-23',
      '3'
    ])
  })
})
