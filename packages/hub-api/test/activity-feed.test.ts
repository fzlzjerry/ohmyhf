import { describe, expect, it } from 'vitest'
import { mapActivityFeed } from '../src'

describe('mapActivityFeed repo kinds', () => {
  it('drops unsupported bucket activity instead of leaking an invalid RepoKind', () => {
    const feed = mapActivityFeed(
      {
        recentActivity: [
          {
            type: 'update',
            user: 'actor',
            repoType: 'bucket',
            repoData: {
              id: 'org/bucket',
              author: 'org',
              repoType: 'bucket'
            }
          }
        ]
      },
      'https://huggingface.co'
    )

    expect(feed.items).toEqual([])
  })

  it('drops discussions for unsupported repo kinds', () => {
    const feed = mapActivityFeed(
      {
        recentActivity: [
          {
            type: 'discussion',
            user: 'actor',
            repoType: 'kernel',
            repoId: 'org/kernel',
            discussionData: { num: 1, title: 'Unsupported resource' }
          }
        ]
      },
      'https://huggingface.co'
    )

    expect(feed.items).toEqual([])
  })

  it('keeps model activity when the Hub omits its default repo type', () => {
    const feed = mapActivityFeed(
      {
        recentActivity: [
          {
            type: 'like',
            user: 'actor',
            repoData: { id: 'org/model', author: 'org' }
          }
        ]
      },
      'https://huggingface.co'
    )

    expect(feed.items).toMatchObject([
      {
        kind: 'like',
        repo: { id: 'org/model', kind: 'model' }
      }
    ])
  })
})
