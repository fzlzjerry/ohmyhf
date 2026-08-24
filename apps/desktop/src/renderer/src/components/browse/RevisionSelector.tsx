import { GitBranch, GitCommitHorizontal, LockKeyhole } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RepoCommitSummary, RepoRefs, RepoRevisionSelection } from '@oh-my-huggingface/shared'
import { cn } from '@/lib/utils'

interface RevisionSelectorProps {
  refs?: RepoRefs
  commits?: RepoCommitSummary[]
  selection?: RepoRevisionSelection
  requested: string
  loading?: boolean
  error?: boolean
  onChange: (revision: string) => void
}

export function RevisionSelector({
  refs,
  commits,
  selection,
  requested,
  loading,
  error,
  onChange
}: RevisionSelectorProps): React.JSX.Element {
  const { t } = useTranslation('common')
  const known = new Set<string>()
  const option = (value: string, label: string): React.JSX.Element | null => {
    if (known.has(value)) return null
    known.add(value)
    return (
      <option key={value} value={value}>
        {label}
      </option>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <GitBranch className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
      <label className="sr-only" htmlFor="repo-revision-selector">
        {t('repro.revision.label')}
      </label>
      <select
        id="repo-revision-selector"
        aria-label={t('repro.revision.label')}
        disabled={loading}
        value={requested}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-7 max-w-56 min-w-32 rounded-md border bg-panel px-2 font-mono text-[11.5px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus',
          error && 'border-danger text-danger'
        )}
      >
        {!known.has(requested) && option(requested, requested)}
        {refs?.branches.length ? (
          <optgroup label="Branches">
            {refs.branches.map((ref) =>
              option(
                ref.name,
                `${ref.name}${ref.isDefault ? t('repro.revision.defaultSuffix') : ''}`
              )
            )}
          </optgroup>
        ) : null}
        {refs?.tags.length ? (
          <optgroup label="Tags">{refs.tags.map((ref) => option(ref.name, ref.name))}</optgroup>
        ) : null}
        {refs?.pullRequests.length ? (
          <optgroup label="Pull requests">
            {refs.pullRequests.map((ref) => option(ref.ref, ref.ref))}
          </optgroup>
        ) : null}
        {commits?.length ? (
          <optgroup label="Recent commits">
            {commits.map((commit) =>
              option(
                commit.id,
                `${commit.id.slice(0, 8)} · ${commit.title || t('repro.revision.commitFallback')}`
              )
            )}
          </optgroup>
        ) : null}
      </select>
      {selection && (
        <span
          className="flex shrink-0 items-center gap-1 rounded border bg-panel px-1.5 py-1 font-mono text-[10.5px] text-ink-muted"
          title={selection.resolvedCommit}
        >
          <GitCommitHorizontal className="size-3" aria-hidden />
          {selection.resolvedCommit.slice(0, 8)}
          {selection.readOnly && (
            <LockKeyhole className="size-3" aria-label={t('repro.revision.readOnly')} />
          )}
        </span>
      )}
    </div>
  )
}
