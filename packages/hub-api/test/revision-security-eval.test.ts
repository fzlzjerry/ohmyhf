import { describe, expect, it, vi } from 'vitest'
import {
  HubClient,
  mapFileTree,
  mapLeaderboardPage,
  mapModelEvalResults,
  mapRepoCommits,
  mapRepoRefs,
  mapSecurityReport
} from '../src'

const COMMIT = 'a'.repeat(40)
const OTHER_COMMIT = 'b'.repeat(40)
const FAST = { cacheTtlMs: 0, minRequestGapMs: 0, maxRetries: 0 } as const

function jsonResponse(body: unknown, init: { status?: number; link?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.link ? { Link: init.link } : {})
    }
  })
}

describe('revision mappers and API identity', () => {
  it('normalizes branches, tags, PR refs and 40-character commits', () => {
    expect(
      mapRepoRefs({
        defaultBranch: 'dev/next',
        branches: [{ name: 'dev/next', ref: 'refs/heads/dev/next', targetCommit: COMMIT }],
        tags: [{ name: 'v1', targetCommit: OTHER_COMMIT }],
        pullRequests: [{ ref: 'refs/pr/17', targetCommit: COMMIT }],
        // Invalid targets must never become an immutable identity.
        prs: [{ ref: 'refs/pr/18', targetCommit: 'short' }]
      })
    ).toEqual({
      branches: [
        {
          name: 'dev/next',
          ref: 'refs/heads/dev/next',
          targetCommit: COMMIT,
          type: 'branch',
          isDefault: true
        }
      ],
      tags: [
        {
          name: 'v1',
          ref: 'refs/tags/v1',
          targetCommit: OTHER_COMMIT,
          type: 'tag',
          isDefault: false
        }
      ],
      pullRequests: [
        {
          name: 'refs/pr/17',
          ref: 'refs/pr/17',
          targetCommit: COMMIT,
          type: 'pull-request',
          isDefault: false
        }
      ],
      defaultBranch: 'dev/next'
    })
  })

  it('maps commit variants and drops malformed commit ids', () => {
    expect(
      mapRepoCommits({
        commits: [
          {
            commit_id: COMMIT.toUpperCase(),
            authors: [{ username: 'alice' }, 'bob'],
            created_at: '2026-08-24T00:00:00Z',
            message: 'Title\n\nBody'
          },
          { id: 'not-a-commit', title: 'ignored' }
        ]
      })
    ).toEqual([
      {
        id: COMMIT,
        authors: ['alice', 'bob'],
        createdAt: '2026-08-24T00:00:00Z',
        title: 'Title',
        message: 'Title\n\nBody'
      }
    ])
  })

  it('resolves a slash-containing branch and preserves requested plus immutable identities', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'org/repo', sha: COMMIT }))
      .mockResolvedValueOnce(
        jsonResponse({
          defaultBranch: 'main',
          branches: [
            { name: 'main', targetCommit: OTHER_COMMIT },
            { name: 'release/1.x', targetCommit: COMMIT }
          ]
        })
      )
    const client = new HubClient({ fetchImpl, ...FAST })
    await expect(client.resolveRevision('model', 'org/repo', 'release/1.x')).resolves.toEqual({
      requested: 'release/1.x',
      resolvedCommit: COMMIT,
      type: 'branch',
      isDefault: false,
      readOnly: false
    })
    const urls = fetchImpl.mock.calls.map((call) => call[0] as string)
    expect(urls).toContain('https://huggingface.co/api/models/org/repo/revision/release%2F1.x')
    expect(urls).toContain('https://huggingface.co/api/models/org/repo/refs?include_prs=true')
  })

  it('does not invent main when the default branch cannot be proven', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          branches: [
            { name: 'main', targetCommit: COMMIT },
            { name: 'dev', targetCommit: OTHER_COMMIT }
          ]
        })
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'org/repo', sha: 'c'.repeat(40) }))
    const client = new HubClient({ fetchImpl, ...FAST })
    await expect(client.getRepoRefs('model', 'org/repo')).resolves.toMatchObject({
      defaultBranch: undefined
    })
  })

  it('pins commit pagination to the expected Hub endpoint and repo path', async () => {
    const next = `https://huggingface.co/api/datasets/org/data/commits/refs%2Fpr%2F1?cursor=next`
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse([{ id: COMMIT, title: 'one' }], { link: `<${next}>; rel="next"` })
        )
      )
    const client = new HubClient({ fetchImpl, ...FAST })
    const page = await client.getRepoCommits('dataset', 'org/data', {
      revision: 'refs/pr/1',
      limit: 10
    })
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://huggingface.co/api/datasets/org/data/commits/refs%2Fpr%2F1?limit=10'
    )
    expect(page.nextCursor).toBe(next)
    await client.getRepoCommits('dataset', 'org/data', {
      revision: 'refs/pr/1',
      cursor: next
    })
    await expect(
      client.getRepoCommits('dataset', 'org/data', {
        revision: 'refs/pr/1',
        cursor: 'https://attacker.invalid/steal'
      })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      client.getRepoCommits('dataset', 'org/other', {
        revision: 'refs/pr/1',
        cursor: next
      })
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('security evidence mapping and requests', () => {
  it('keeps repository and file scanner evidence distinct and reports missing fields as unknown', () => {
    const report = mapSecurityReport(
      {
        securityRepoStatus: { malware: 'safe', pickleImportScan: 'pending' },
        tags: ['license:apache-2.0', 'custom_code'],
        library_name: 'transformers',
        cardData: { base_model: ['org/base'] },
        authors: ['alice'],
        lastModified: '2026-08-24T00:00:00Z',
        signatureVerified: true
      },
      [
        {
          type: 'file',
          path: 'model.gguf',
          size: 42,
          security: { status: 'safe', scanners: ['av'] }
        }
      ],
      'model',
      'org/repo',
      'v1',
      COMMIT
    )
    expect(report).toMatchObject({
      revision: 'v1',
      resolvedCommit: COMMIT,
      overall: 'warning',
      provenance: {
        license: 'apache-2.0',
        baseModels: ['org/base'],
        library: 'transformers',
        customCode: true
      },
      commit: { authors: ['alice'], signature: 'verified' }
    })
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'malware', status: 'safe' }),
        expect.objectContaining({ source: 'pickleImportScan', status: 'pending' }),
        expect.objectContaining({ source: 'av', status: 'safe', filePath: 'model.gguf' }),
        expect.objectContaining({ source: 'model-metadata.custom-code', status: 'warning' })
      ])
    )
    expect(report.reasons).toEqual(
      expect.arrayContaining(['scan-pending', 'custom-code', 'trust-remote-code'])
    )
    expect(report.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)

    const unknown = mapSecurityReport({}, [], 'dataset', 'org/data', 'main', COMMIT)
    expect(unknown.overall).toBe('unknown')
    expect(unknown.evidence).toEqual([{ source: 'hub', status: 'unknown' }])
  })

  it('normalizes current and legacy expanded-tree scanner envelopes', () => {
    const tree = mapFileTree([
      {
        type: 'file',
        path: 'infected.bin',
        size: 4,
        securityFileStatus: {
          status: 'unsafe',
          avScan: {
            virusFound: true,
            virusNames: ['EICAR'],
            scannedAt: '2026-08-24T10:00:00Z'
          },
          pickleImportScan: { highestSafetyLevel: 'dangerous' }
        }
      },
      {
        type: 'file',
        path: 'legacy.bin',
        size: 4,
        security: {
          hf: {
            safe: true,
            indexed: false,
            avScan: { virusFound: false },
            pickleImportScan: { highestSafetyLevel: 'innocuous', imports: [] }
          }
        }
      }
    ])
    expect(tree[0]?.security).toMatchObject({ status: 'malicious' })
    expect(tree[0]?.security?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'hub-file-scan.avScan', status: 'malicious' }),
        expect.objectContaining({
          source: 'hub-file-scan.pickleImportScan',
          status: 'warning'
        })
      ])
    )
    expect(tree[1]?.security).toMatchObject({ status: 'safe' })
    expect(tree[1]?.security?.scanners).not.toContain('hub-file-scan.indexed')
  })

  it('requests securityStatus independently from evalResults at the exact commit', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const value = String(url)
      if (value.includes('/tree/')) return jsonResponse([])
      if (value.includes('securityStatus=true')) return jsonResponse({ id: 'org/repo' })
      if (value.includes('expand%5B%5D=evalResults')) return jsonResponse({ evalResults: [] })
      return jsonResponse({})
    })
    const client = new HubClient({ fetchImpl, ...FAST })
    await client.getSecurityReport('model', 'org/repo', 'v1', COMMIT)
    await client.getModelEvalResults('org/repo', COMMIT)
    const urls = fetchImpl.mock.calls.map((call) => String(call[0]))
    const securityUrl = urls.find((url) => url.includes('securityStatus=true'))!
    const evalUrl = urls.find((url) => url.includes('evalResults'))!
    expect(securityUrl).toContain(`/revision/${COMMIT}`)
    expect(securityUrl).not.toContain('evalResults')
    expect(evalUrl).toContain(`/revision/${COMMIT}`)
    expect(evalUrl).not.toContain('securityStatus')
  })
})

describe('evaluation and leaderboard normalization', () => {
  it('fetches legacy model-index at the same commit only when expanded results are absent', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const value = String(url)
      if (value.includes('expand%5B%5D=evalResults')) {
        return jsonResponse({ evalResults: [] })
      }
      return jsonResponse({
        cardData: {
          'model-index': [
            {
              results: [
                {
                  task: { type: 'text-classification' },
                  dataset: { type: 'org/bench', split: 'test' },
                  metrics: [{ type: 'accuracy', value: 0.84 }]
                }
              ]
            }
          ]
        }
      })
    })
    const client = new HubClient({ fetchImpl, ...FAST })
    await expect(client.getModelEvalResults('org/repo', COMMIT)).resolves.toEqual([
      expect.objectContaining({ value: 0.84, source: 'model-index' })
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      `https://huggingface.co/api/models/org/repo/revision/${COMMIT}?expand%5B%5D=evalResults`,
      `https://huggingface.co/api/models/org/repo/revision/${COMMIT}`
    ])
  })

  it('prefers canonical eval results and uses model-index only to fill missing identities', () => {
    const mapped = mapModelEvalResults({
      evalResults: [
        {
          task: { type: 'text-classification' },
          dataset: { type: 'org/bench', config: 'en', split: 'test', revision: 'v2' },
          metrics: [{ type: 'accuracy', value: 0.91, verified: true }],
          createdAt: '2026-08-24'
        }
      ],
      cardData: {
        'model-index': [
          {
            results: [
              {
                task: { type: 'text-classification' },
                dataset: { type: 'org/bench', config: 'en', split: 'test', revision: 'v2' },
                metrics: [
                  { type: 'accuracy', value: 0.5 },
                  { type: 'f1', value: 0.88 }
                ]
              }
            ]
          }
        ]
      }
    })
    expect(mapped).toHaveLength(2)
    expect(mapped.find((item) => item.identity.metric === 'accuracy')).toMatchObject({
      value: 0.91,
      source: 'eval-results',
      verified: true
    })
    expect(mapped.find((item) => item.identity.metric === 'f1')).toMatchObject({
      value: 0.88,
      source: 'model-index'
    })
    expect(mapped[0]!.identity).toEqual({
      datasetId: 'org/bench',
      taskId: 'text-classification',
      config: 'en',
      split: 'test',
      revision: 'v2',
      metric: 'accuracy'
    })
  })

  it('maps raw leaderboard values without inventing metric direction or cross-dataset scores', () => {
    const page = mapLeaderboardPage(
      {
        entries: [
          {
            rank: 7,
            model_id: 'org/model',
            task_id: 'text-generation',
            config: 'default',
            split: 'test',
            dataset_revision: 'v3',
            metric_id: 'loss',
            value: '1.25',
            verified: true,
            source: 'community',
            filename: '.eval_results/bench.yaml',
            revision: COMMIT,
            pull_request: 'refs/pr/9',
            notes: 'reproduced'
          }
        ]
      },
      'org/bench',
      'next'
    )
    expect(page).toEqual({
      datasetId: 'org/bench',
      nextCursor: 'next',
      entries: [
        {
          rank: 7,
          modelId: 'org/model',
          identity: {
            datasetId: 'org/bench',
            taskId: 'text-generation',
            config: 'default',
            split: 'test',
            revision: 'v3',
            metric: 'loss'
          },
          value: '1.25',
          verified: true,
          identityProvided: true,
          source: 'community',
          filename: '.eval_results/bench.yaml',
          revision: COMMIT,
          notes: 'reproduced',
          pullRequest: 'refs/pr/9'
        }
      ]
    })
  })

  it('retains official leaderboard rows whose API omits task and metric metadata', () => {
    const page = mapLeaderboardPage(
      [
        {
          rank: 1,
          filename: '.eval_results/score.yaml',
          value: 86,
          verified: false,
          source: {
            url: 'https://huggingface.co/org/model',
            name: 'Model card',
            isExternal: false
          },
          pullRequest: 12,
          modelId: 'org/model',
          author: { name: 'org', fullname: 'The Org', type: 'org' },
          lower_is_better: false,
          num_parameters: 123
        }
      ],
      'org/benchmark'
    )
    expect(page.entries).toEqual([
      expect.objectContaining({
        rank: 1,
        modelId: 'org/model',
        identity: {
          datasetId: 'org/benchmark',
          taskId: 'dataset-leaderboard',
          metric: 'raw-score'
        },
        identityProvided: false,
        value: 86,
        source: 'Model card',
        sourceUrl: 'https://huggingface.co/org/model',
        sourceExternal: false,
        author: { name: 'org', fullname: 'The Org', type: 'org' },
        filename: '.eval_results/score.yaml',
        pullRequest: '12',
        lowerIsBetter: false,
        parameterCount: 123
      })
    ])
  })

  it('keeps leaderboard pagination on the exact dataset endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]))
    const client = new HubClient({ fetchImpl, ...FAST })
    await client.getDatasetLeaderboard('org/bench', { limit: 25 })
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://huggingface.co/api/datasets/org/bench/leaderboard?limit=25'
    )
    await expect(
      client.getDatasetLeaderboard('org/bench', {
        cursor: 'https://attacker.invalid/api/datasets/org/bench/leaderboard?cursor=x'
      })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      client.getDatasetLeaderboard('org/bench', {
        cursor: 'https://huggingface.co/api/datasets/org/other/leaderboard?cursor=x'
      })
    ).rejects.toMatchObject({ status: 400 })
  })
})
