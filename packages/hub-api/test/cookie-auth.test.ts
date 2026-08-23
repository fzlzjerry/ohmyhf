/**
 * Cookie-session auth: the social writes the Hub blocks for Bearer tokens
 * (like, post reactions/comments, watch, discussion reactions) and the
 * personalized following feed authenticate with the huggingface.co `token`
 * cookie instead. Endpoint shapes live-captured 2026-07-11 (mutations) and
 * 2026-08-23 (following feed).
 */
import { describe, expect, it, vi } from 'vitest'
import { CookieRequiredError, HubClient, isCookieRequired, isUnauthorized } from '../src'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const FAST = { cacheTtlMs: 0, minRequestGapMs: 0 } as const

function requestOf(
  fetchImpl: ReturnType<typeof vi.fn>,
  call = 0
): { url: string; init: RequestInit } {
  return {
    url: fetchImpl.mock.calls[call]![0] as string,
    init: (fetchImpl.mock.calls[call]![1] ?? {}) as RequestInit
  }
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>
}

function jsonBodyOf(init: RequestInit): unknown {
  return JSON.parse(init.body as string)
}

function cookieClient(fetchImpl: typeof fetch): HubClient {
  return new HubClient({
    fetchImpl,
    ...FAST,
    getAccessToken: () => 'hf_token',
    getSessionCookie: () => 'session_cookie'
  })
}

describe('cookie-authenticated mutations', () => {
  it('sends the session cookie and never the bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    await cookieClient(fetchImpl).setLike('model', 'a/b', true)
    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe('https://huggingface.co/api/models/a/b/like')
    expect(init.method).toBe('POST')
    const headers = headersOf(init)
    expect(headers.Cookie).toBe('token=session_cookie')
    expect(headers.Authorization).toBeUndefined()
    expect(headers.Origin).toBe('https://huggingface.co')
    expect(headers.Referer).toBe('https://huggingface.co/')
  })

  it('unlike stays on bearer auth (works for token-only sessions)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    await cookieClient(fetchImpl).setLike('model', 'a/b', false)
    const { init } = requestOf(fetchImpl)
    expect(init.method).toBe('DELETE')
    const headers = headersOf(init)
    expect(headers.Authorization).toBe('Bearer hf_token')
    expect(headers.Cookie).toBeUndefined()
  })

  it('throws CookieRequiredError before any I/O when no web session is connected', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new HubClient({ fetchImpl, ...FAST, getAccessToken: () => 'hf_token' })
    const attempt = client.setLike('model', 'a/b', true)
    await expect(attempt).rejects.toBeInstanceOf(CookieRequiredError)
    await expect(attempt).rejects.toSatisfy(isCookieRequired)
    // No 401/403 status: must never be mistaken for a token-auth failure.
    await expect(attempt).rejects.toSatisfy((err) => !isUnauthorized(err))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses to send the cookie to hosts outside the auth allowlist', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new HubClient({
      fetchImpl,
      ...FAST,
      endpoint: 'not a url',
      getSessionCookie: () => 'session_cookie'
    })
    await expect(client.setLike('model', 'a/b', true)).rejects.toBeInstanceOf(CookieRequiredError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('invalidates the GET cache after a cookie mutation', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({})))
    const client = new HubClient({
      fetchImpl,
      cacheTtlMs: 60_000,
      minRequestGapMs: 0,
      getSessionCookie: () => 'session_cookie'
    })
    await client.getDiscussion('model', 'a/b', 5)
    await client.getDiscussion('model', 'a/b', 5)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await client.setLike('model', 'a/b', true)
    await client.getDiscussion('model', 'a/b', 5)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})

describe('HubClient.setPostReaction', () => {
  it('POSTs {reaction, action: add} to react', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    await cookieClient(fetchImpl).setPostReaction('julien', '12345', '👍', true)
    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe('https://huggingface.co/api/posts/julien/12345/reaction')
    expect(init.method).toBe('POST')
    expect(jsonBodyOf(init)).toEqual({ reaction: '👍', action: 'add' })
    expect(headersOf(init).Cookie).toBe('token=session_cookie')
  })

  it('POSTs {reaction, action: remove} to unreact (toggle is POST both ways)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    await cookieClient(fetchImpl).setPostReaction('julien', '12345', '🔥', false)
    const { init } = requestOf(fetchImpl)
    expect(init.method).toBe('POST')
    expect(jsonBodyOf(init)).toEqual({ reaction: '🔥', action: 'remove' })
  })
})

describe('HubClient.setDiscussionCommentReaction', () => {
  it('POSTs to the comment reaction endpoint with {reaction, action}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    await cookieClient(fetchImpl).setDiscussionCommentReaction(
      'model',
      'a/b',
      7,
      '6608ca7bbc8b7a1e30ba53e1',
      '🚀',
      true
    )
    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe(
      'https://huggingface.co/api/models/a/b/discussions/7/comment/6608ca7bbc8b7a1e30ba53e1/reaction'
    )
    expect(init.method).toBe('POST')
    expect(jsonBodyOf(init)).toEqual({ reaction: '🚀', action: 'add' })
    expect(headersOf(init).Cookie).toBe('token=session_cookie')
  })

  it('requires a web session', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new HubClient({ fetchImpl, ...FAST })
    await expect(
      client.setDiscussionCommentReaction('model', 'a/b', 7, '6608ca7bbc8b7a1e30ba53e1', '🚀', true)
    ).rejects.toBeInstanceOf(CookieRequiredError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('HubClient.setPaperCommentReaction', () => {
  it('POSTs to the paper comment reaction endpoint with {reaction, action}', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    await cookieClient(fetchImpl).setPaperCommentReaction(
      '2310.06825',
      '6526cf453b3b217bf81225fc',
      '🔥',
      true
    )
    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe(
      'https://huggingface.co/api/papers/2310.06825/comment/6526cf453b3b217bf81225fc/reaction'
    )
    expect(init.method).toBe('POST')
    expect(jsonBodyOf(init)).toEqual({ reaction: '🔥', action: 'add' })
    expect(headersOf(init).Cookie).toBe('token=session_cookie')
  })

  it('requires a web session', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new HubClient({ fetchImpl, ...FAST })
    await expect(
      client.setPaperCommentReaction('2310.06825', '6526cf453b3b217bf81225fc', '🔥', true)
    ).rejects.toBeInstanceOf(CookieRequiredError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('HubClient.updateWatch auth mode', () => {
  it('uses the cookie when a web session is connected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ watched: [] }))
    await cookieClient(fetchImpl).updateWatch({
      add: [{ id: 'alice', type: 'user' }]
    })
    const headers = headersOf(requestOf(fetchImpl).init)
    expect(headers.Cookie).toBe('token=session_cookie')
    expect(headers.Authorization).toBeUndefined()
  })

  it('falls back to bearer auth without one (reads keep working)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ watched: [] }))
    const client = new HubClient({ fetchImpl, ...FAST, getAccessToken: () => 'hf_token' })
    await client.listWatched()
    const headers = headersOf(requestOf(fetchImpl).init)
    expect(headers.Authorization).toBe('Bearer hf_token')
    expect(headers.Cookie).toBeUndefined()
  })
})

describe('HubClient.whoAmIWithCookie', () => {
  it('validates out of band with the explicit cookie', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ name: 'julien', orgs: [], auth: {} }))
    const client = new HubClient({ fetchImpl, ...FAST, getAccessToken: () => 'hf_token' })
    const result = await client.whoAmIWithCookie('candidate_cookie')
    expect(result.user.name).toBe('julien')
    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe('https://huggingface.co/api/whoami-v2')
    const headers = headersOf(init)
    expect(headers.Cookie).toBe('token=candidate_cookie')
    expect(headers.Authorization).toBeUndefined()
  })
})

describe('HubClient.setPostCommentReaction', () => {
  it('POSTs to the post comment reaction endpoint with the session cookie', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    await cookieClient(fetchImpl).setPostCommentReaction(
      'julien',
      '12345',
      '6608ca7bbc8b7a1e30ba53e1',
      '👀',
      true
    )
    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe(
      'https://huggingface.co/api/posts/julien/12345/comment/6608ca7bbc8b7a1e30ba53e1/reaction'
    )
    expect(jsonBodyOf(init)).toEqual({ reaction: '👀', action: 'add' })
    expect(headersOf(init).Cookie).toBe('token=session_cookie')
  })
})

describe('HubClient upvotes', () => {
  it('POSTs a paper upvote and DELETEs to remove it (cookie-authed)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    const client = cookieClient(fetchImpl)
    await client.setPaperUpvote('2607.03118', true)
    expect(requestOf(fetchImpl, 0).url).toBe('https://huggingface.co/api/papers/2607.03118/upvote')
    expect(requestOf(fetchImpl, 0).init.method).toBe('POST')
    expect(headersOf(requestOf(fetchImpl, 0).init).Cookie).toBe('token=session_cookie')
    await client.setPaperUpvote('2607.03118', false)
    expect(requestOf(fetchImpl, 1).init.method).toBe('DELETE')
  })

  it('POSTs/DELETEs a collection upvote', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    const slug = 'deepreinforce-ai/ornith-10-6a3caf42676d2e4b66ffc96c'
    const client = cookieClient(fetchImpl)
    await client.setCollectionUpvote(slug, true)
    expect(requestOf(fetchImpl, 0).url).toBe(
      `https://huggingface.co/api/collections/${slug}/upvote`
    )
    expect(requestOf(fetchImpl, 0).init.method).toBe('POST')
    await client.setCollectionUpvote(slug, false)
    expect(requestOf(fetchImpl, 1).init.method).toBe('DELETE')
  })

  it('upvotes require a web session', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new HubClient({ fetchImpl, ...FAST, getAccessToken: () => 'hf_token' })
    await expect(client.setPaperUpvote('2607.03118', true)).rejects.toBeInstanceOf(
      CookieRequiredError
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('HubClient.canCreatePost', () => {
  it('reports canPost:false without a web session and never calls the Hub', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new HubClient({ fetchImpl, ...FAST, getAccessToken: () => 'hf_token' })
    await expect(client.canCreatePost()).resolves.toEqual({ canPost: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads the Hub gate with the cookie when connected', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ canPost: false, reason: 'beta only' }))
    const result = await cookieClient(fetchImpl).canCreatePost()
    expect(result).toEqual({ canPost: false, reason: 'beta only' })
    expect(headersOf(requestOf(fetchImpl).init).Cookie).toBe('token=session_cookie')
  })
})

describe('HubClient.getPostComments', () => {
  it('parses the comment thread out of the post page HTML island', async () => {
    const props = {
      socialPost: {
        comments: [
          {
            id: '6a51ca9985275a13cd25f2ba',
            type: 'comment',
            author: { name: 'LuYinMiao', avatarUrl: '/avatars/x.svg', isPro: false },
            createdAt: '2026-07-11T04:46:17.000Z',
            data: {
              hidden: false,
              latest: { raw: 'wow, fantastic!' },
              reactions: [{ reaction: '🔥', users: ['a'], count: 1 }]
            }
          },
          {
            id: 'withreply',
            type: 'comment',
            author: { name: 'op' },
            data: { latest: { raw: 'top comment' }, reactions: [] },
            replies: [
              {
                id: 'reply1',
                type: 'comment',
                author: { name: 'responder' },
                createdAt: '2026-07-11T05:00:00.000Z',
                data: { latest: { raw: 'a nested reply' }, reactions: [] }
              }
            ]
          },
          {
            id: 'hidden1',
            type: 'comment',
            author: { name: 'spammer' },
            data: { hidden: true, hiddenReason: 'Off-Topic', hiddenBy: 'mod', latest: { raw: 'x' } }
          }
        ]
      }
    }
    const html = `<div data-target="SocialPost" data-props="${JSON.stringify(props).replace(/"/g, '&quot;')}"></div>`
    const fetchImpl = vi.fn().mockResolvedValue(new Response(html, { status: 200 }))
    const comments = await new HubClient({ fetchImpl, ...FAST }).getPostComments('julien', '12345')
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://huggingface.co/posts/julien/12345')
    // Hidden comments are kept (content withheld) so the UI can show a placeholder.
    expect(comments).toHaveLength(3)
    expect(comments[0]).toMatchObject({
      id: '6a51ca9985275a13cd25f2ba',
      author: 'LuYinMiao',
      authorAvatarUrl: 'https://huggingface.co/avatars/x.svg',
      content: 'wow, fantastic!',
      reactions: [{ emoji: '🔥', count: 1, users: ['a'] }]
    })
    // Nested replies are threaded under their parent comment.
    expect(comments[1]).toMatchObject({ id: 'withreply', content: 'top comment' })
    expect(comments[1]!.replies).toEqual([
      expect.objectContaining({ id: 'reply1', author: 'responder', content: 'a nested reply' })
    ])
    expect(comments[2]).toMatchObject({
      id: 'hidden1',
      hidden: true,
      hiddenReason: 'Off-Topic',
      hiddenBy: 'mod',
      content: ''
    })
  })

  it('degrades to an empty thread when the island is missing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>no island</html>', { status: 200 }))
    await expect(
      new HubClient({ fetchImpl, ...FAST }).getPostComments('julien', '12345')
    ).resolves.toEqual([])
  })
})

describe('HubClient.hidePostComment', () => {
  it('POSTs to the hide endpoint with the verbatim reason (cookie-authed)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    await cookieClient(fetchImpl).hidePostComment(
      'julien',
      '12345',
      '6608ca7bbc8b7a1e30ba53e1',
      'Off-Topic'
    )
    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe(
      'https://huggingface.co/api/posts/julien/12345/comment/6608ca7bbc8b7a1e30ba53e1/hide'
    )
    expect(init.method).toBe('POST')
    expect(jsonBodyOf(init)).toEqual({ reason: 'Off-Topic' })
    expect(headersOf(init).Cookie).toBe('token=session_cookie')
  })

  it('omits the reason when none is given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    await cookieClient(fetchImpl).hidePostComment('julien', '12345', '6608ca7bbc8b7a1e30ba53e1')
    expect(jsonBodyOf(requestOf(fetchImpl).init)).toEqual({})
  })

  it('requires a web session', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new HubClient({ fetchImpl, ...FAST })
    await expect(
      client.hidePostComment('julien', '12345', '6608ca7bbc8b7a1e30ba53e1', 'Spam')
    ).rejects.toBeInstanceOf(CookieRequiredError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('HubClient.uploadCommentAsset', () => {
  it('POSTs raw bytes to /uploads with the file content-type and returns the CDN URL', async () => {
    const cdnUrl = 'https://cdn-uploads.huggingface.co/production/uploads/abc/xyz.png'
    const fetchImpl = vi.fn().mockResolvedValue(new Response(`${cdnUrl}\n`, { status: 200 }))
    const bytes = new Uint8Array([1, 2, 3])
    const result = await cookieClient(fetchImpl).uploadCommentAsset(bytes, 'image/png')
    expect(result).toBe(cdnUrl)
    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe('https://huggingface.co/uploads')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(bytes)
    const headers = headersOf(init)
    expect(headers['Content-Type']).toBe('image/png')
    expect(headers.Cookie).toBe('token=session_cookie')
  })

  it('requires a web session (no bytes leave without one)', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new HubClient({ fetchImpl, ...FAST })
    await expect(
      client.uploadCommentAsset(new Uint8Array([0]), 'image/png')
    ).rejects.toBeInstanceOf(CookieRequiredError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

/** SSR settings/profile page: SocialPost-style form with csrf + current values. */
const PROFILE_PAGE = `<!doctype html>
<form action="/logout" method="POST"><input type="hidden" name="csrf" value="logout_csrf"></form>
<form method="post">
  <input type="hidden" name="csrf" value="csrf_token_123">
  <input type="text" name="fullname" maxlength="50" value="Morax &amp; Co">
  <input type="file" accept="image/png, image/jpeg, image/webp">
  <input type="hidden" name="avatar" value="">
  <select name="primaryOrg">
    <option value="">None</option>
    <option value="acme" selected>Acme Corp</option>
  </select>
  <input type="url" name="homepage" value="https://example.com">
  <textarea name="details">
LLMs &amp; agents</textarea>
  <input type="text" name="github" value="octocat">
  <input type="text" name="twitter" value="">
  <input type="text" name="linkedin" value="">
  <input type="text" name="bluesky" value="">
  <button type="submit">Save changes</button>
</form>`

describe('HubClient profile settings', () => {
  it('parses the Settings → Profile form from the SSR page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(PROFILE_PAGE, { status: 200 }))
    const settings = await cookieClient(fetchImpl).getProfileSettings()
    expect(settings).toEqual({
      fullname: 'Morax & Co',
      homepage: 'https://example.com',
      details: 'LLMs & agents',
      github: 'octocat',
      twitter: '',
      linkedin: '',
      bluesky: '',
      primaryOrg: 'acme',
      primaryOrgOptions: [{ value: 'acme', label: 'Acme Corp' }]
    })
    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe('https://huggingface.co/settings/profile')
    expect(headersOf(init).Cookie).toBe('token=session_cookie')
  })

  it('saves via a urlencoded POST carrying the freshly fetched csrf token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(PROFILE_PAGE, {
          status: 200,
          headers: {
            'Set-Cookie': 'csrf=csrf_cookie_abc; Path=/; HttpOnly; SameSite=Lax'
          }
        })
      )
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    await cookieClient(fetchImpl).updateProfileSettings({
      fullname: 'New Name',
      homepage: 'https://new.example',
      details: 'RL',
      github: 'octocat',
      twitter: 'tw',
      linkedin: '',
      bluesky: '',
      primaryOrg: '',
      avatar: 'https://cdn-uploads.huggingface.co/production/uploads/x/y.png'
    })
    const { url, init } = requestOf(fetchImpl, 1)
    expect(url).toBe('https://huggingface.co/settings/profile')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    const headers = headersOf(init)
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(headers.Referer).toBe('https://huggingface.co/settings/profile')
    expect(headers.Cookie).toBe('token=session_cookie; csrf=csrf_cookie_abc')
    const body = new URLSearchParams(init.body as string)
    // The profile form's own csrf — not the logout form's.
    expect(body.get('csrf')).toBe('csrf_token_123')
    expect(body.get('fullname')).toBe('New Name')
    expect(body.get('avatar')).toBe('https://cdn-uploads.huggingface.co/production/uploads/x/y.png')
    expect(body.get('primaryOrg')).toBe('')
    expect(body.get('bluesky')).toBe('')
  })

  it('mirrors the form csrf into a cookie when the GET set none', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(PROFILE_PAGE, { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    await cookieClient(fetchImpl).updateProfileSettings({
      fullname: 'n',
      homepage: '',
      details: '',
      github: '',
      twitter: '',
      linkedin: '',
      bluesky: '',
      primaryOrg: ''
    })
    expect(headersOf(requestOf(fetchImpl, 1).init).Cookie).toBe(
      'token=session_cookie; csrf=csrf_token_123'
    )
  })

  it('accepts a full cookie jar from login capture without double-wrapping token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    const client = new HubClient({
      fetchImpl,
      ...FAST,
      getSessionCookie: () => 'token=session_cookie; foo=bar'
    })
    await client.setLike('model', 'a/b', true)
    expect(headersOf(requestOf(fetchImpl).init).Cookie).toBe('token=session_cookie; foo=bar')
  })

  it('treats a 302 back to the profile page as a successful save', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(PROFILE_PAGE, { status: 200 }))
      .mockResolvedValueOnce(
        new Response('', {
          status: 302,
          headers: { Location: '/settings/profile' }
        })
      )
    await expect(
      cookieClient(fetchImpl).updateProfileSettings({
        fullname: 'n',
        homepage: '',
        details: '',
        github: '',
        twitter: '',
        linkedin: '',
        bluesky: '',
        primaryOrg: 'acme'
      })
    ).resolves.toBeUndefined()
  })

  it('a 302 to /login surfaces as a 401 (stale cookie)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(PROFILE_PAGE, { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 302, headers: { Location: '/login' } }))
    await expect(
      cookieClient(fetchImpl).updateProfileSettings({
        fullname: 'n',
        homepage: '',
        details: '',
        github: '',
        twitter: '',
        linkedin: '',
        bluesky: '',
        primaryOrg: ''
      })
    ).rejects.toSatisfy(isUnauthorized)
  })

  it('omits HTML error bodies from HubApiError messages', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(PROFILE_PAGE, { status: 200 }))
      .mockResolvedValueOnce(
        new Response('<!doctype html><html class="light"><head><meta charset="utf-8" /></head>', {
          status: 403,
          statusText: 'Forbidden'
        })
      )
    await expect(
      cookieClient(fetchImpl).updateProfileSettings({
        fullname: 'n',
        homepage: '',
        details: '',
        github: '',
        twitter: '',
        linkedin: '',
        bluesky: '',
        primaryOrg: ''
      })
    ).rejects.toMatchObject({
      name: 'HubApiError',
      status: 403,
      message: 'POST https://huggingface.co/settings/profile failed: 403 Forbidden'
    })
  })

  it('surfaces Hub x-error-message on HTML 403 responses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(PROFILE_PAGE, { status: 200 }))
      .mockResolvedValueOnce(
        new Response('<!doctype html><html></html>', {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'x-error-message': 'This organization is not a paid organization' }
        })
      )
    await expect(
      cookieClient(fetchImpl).updateProfileSettings({
        fullname: 'n',
        homepage: '',
        details: '',
        github: '',
        twitter: '',
        linkedin: '',
        bluesky: '',
        primaryOrg: 'free-org'
      })
    ).rejects.toMatchObject({
      status: 403,
      message:
        'POST https://huggingface.co/settings/profile failed: 403 Forbidden: This organization is not a paid organization'
    })
  })

  it('an omitted avatar posts the empty keep-current sentinel', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(PROFILE_PAGE, { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    await cookieClient(fetchImpl).updateProfileSettings({
      fullname: 'n',
      homepage: '',
      details: '',
      github: '',
      twitter: '',
      linkedin: '',
      bluesky: '',
      primaryOrg: ''
    })
    const body = new URLSearchParams(requestOf(fetchImpl, 1).init.body as string)
    expect(body.get('avatar')).toBe('')
  })

  it('a login page instead of the form surfaces as a 401 (stale cookie)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('<!doctype html><form><input name="username"></form>', { status: 200 })
      )
    const attempt = cookieClient(fetchImpl).getProfileSettings()
    await expect(attempt).rejects.toSatisfy(isUnauthorized)
  })

  it('requires a web session before any I/O', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new HubClient({ fetchImpl, ...FAST, getAccessToken: () => 'hf_token' })
    await expect(client.getProfileSettings()).rejects.toBeInstanceOf(CookieRequiredError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('cookie-authenticated following feed', () => {
  it('sends the session cookie and never the bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ recentActivity: [] }))
    const feed = await cookieClient(fetchImpl).getRecentActivity()
    expect(feed.items).toEqual([])
    const { url, init } = requestOf(fetchImpl)
    expect(url).toBe(
      'https://huggingface.co/api/recent-activity?limit=30&feedType=following&activityType=all'
    )
    const headers = headersOf(init)
    expect(headers.Cookie).toBe('token=session_cookie')
    expect(headers.Authorization).toBeUndefined()
    expect(headers.Origin).toBe('https://huggingface.co')
  })

  it('throws CookieRequiredError before any I/O when no web session is connected', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new HubClient({ fetchImpl, ...FAST, getAccessToken: () => 'hf_token' })
    const attempt = client.getRecentActivity()
    await expect(attempt).rejects.toBeInstanceOf(CookieRequiredError)
    await expect(attempt).rejects.toSatisfy(isCookieRequired)
    await expect(attempt).rejects.toSatisfy((err) => !isUnauthorized(err))
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
