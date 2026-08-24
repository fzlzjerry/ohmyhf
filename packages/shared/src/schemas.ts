/**
 * zod schemas used by main-process IPC handlers to validate every request payload
 * before acting on it. One schema per channel that accepts input.
 */
import { z } from 'zod'
import type { IpcInvokeChannel } from './ipc'
import { SUPPORTED_LOCALES } from './types'

const repoKind = z.enum(['model', 'dataset', 'space'])

/** "owner/name" or single-segment names; dot-only segments (".", "..") are rejected. */
const repoId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w.-]+(\/[\w.-]+)?$/, 'invalid repo id')
  .refine((v) => v.split('/').every((segment) => !/^\.+$/.test(segment)), 'invalid repo id')

/**
 * Renderer-safe predicate mirroring the `repoId` schema above: "owner/name" or
 * single-segment ids like "gpt2"; dot-only segments (".", "..") are rejected.
 */
export function isValidRepoId(id: string): boolean {
  return repoId.safeParse(id).success
}

const revision = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w./-]+$/, 'invalid revision')
  .refine(
    (value) => value.split('/').every((segment) => segment && segment !== '.' && segment !== '..'),
    'invalid revision'
  )

const gitRefName = revision.refine(
  (value) =>
    value !== '@' &&
    !value.startsWith('.') &&
    !value.endsWith('.') &&
    !value.endsWith('/') &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.includes('@{') &&
    value.split('/').every((segment) => !segment.startsWith('.') && !segment.endsWith('.lock')),
  'invalid Git ref name'
)

const commitSha = z.string().regex(/^[0-9a-f]{40}$/, 'invalid commit')
const uuid = z.uuid()

const relPath = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^(?!\/)(?![A-Za-z]:[\\/])(?!.*\\)[^\0]+$/, 'invalid path')
  .refine(
    (value) => value.split('/').every((segment) => segment && segment !== '.' && segment !== '..'),
    'invalid path'
  )

const securityAction = z.enum(['download', 'export', 'local-run', 'lock-restore'])
const localRuntimeKind = z.enum(['ollama', 'llama.cpp'])
const securityReason = z.enum([
  'confirmed-malicious',
  'repository-malicious',
  'scan-pending',
  'scan-error',
  'scan-unknown',
  'pickle-format',
  'executable-file',
  'custom-code',
  'trust-remote-code',
  'unscanned-file',
  'other-file-malicious'
])

const lockFileEntry = z
  .object({
    path: relPath,
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    lfsSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    gitBlobOid: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    localSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
  })
  .strict()
  .refine((value) => Boolean(value.lfsSha256 || value.gitBlobOid), {
    message: 'lock file requires an immutable Hub object id'
  })

const lockRuntime = z
  .object({
    runtime: localRuntimeKind,
    filePath: relPath,
    contextLength: z.number().int().min(128).max(1_048_576),
    maxTokens: z.number().int().min(1).max(32_768),
    temperature: z.number().min(0).max(2),
    gpuLayers: z.union([z.literal('auto'), z.number().int().min(0).max(1000)]).optional()
  })
  .strict()

export const downloadPostActionSchema = z
  .object({
    kind: z.literal('local-run'),
    runtime: localRuntimeKind,
    filePath: relPath,
    contextLength: z.number().int().min(128).max(1_048_576),
    maxTokens: z.number().int().min(1).max(32_768),
    temperature: z.number().min(0).max(2),
    gpuLayers: z.union([z.literal('auto'), z.number().int().min(0).max(1000)]).optional(),
    allowTightFit: z.boolean().optional(),
    securityAcknowledgement: z
      .object({
        fingerprint: z.string().min(1).max(256),
        binding: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        acceptedAt: z.iso.datetime()
      })
      .strict()
      .optional()
  })
  .strict()

const lockResource = z
  .object({
    kind: repoKind,
    repoId,
    requestedRevision: revision,
    resolvedCommit: commitSha,
    files: z.array(lockFileEntry).max(10_000).optional(),
    runtime: lockRuntime.optional(),
    security: z
      .object({
        decision: z.enum(['allow', 'confirm', 'block']),
        reasons: z.array(securityReason).max(32),
        fingerprint: z.string().min(1).max(256),
        checkedAt: z.iso.datetime()
      })
      .strict()
      .optional()
  })
  .strict()

export const ohmyhfLockV1Schema = z
  .object({
    format: z.literal('ohmyhf-lock/v1'),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    hubEndpoint: z.url({ protocol: /^https?$/ }),
    resources: z.array(lockResource).min(1).max(100)
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    for (const [index, resource] of value.resources.entries()) {
      const key = `${resource.kind}\0${resource.repoId}\0${resource.resolvedCommit}`
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate lock resource',
          path: ['resources', index]
        })
      }
      seen.add(key)
      const paths = new Set<string>()
      for (const [fileIndex, file] of (resource.files ?? []).entries()) {
        if (paths.has(file.path)) {
          ctx.addIssue({
            code: 'custom',
            message: 'duplicate lock file',
            path: ['resources', index, 'files', fileIndex]
          })
        }
        paths.add(file.path)
      }
      if (resource.runtime) {
        if (resource.kind !== 'model') {
          ctx.addIssue({
            code: 'custom',
            message: 'runtime configuration requires a model resource',
            path: ['resources', index, 'runtime']
          })
        }
        if (!resource.runtime.filePath.toLowerCase().endsWith('.gguf')) {
          ctx.addIssue({
            code: 'custom',
            message: 'runtime configuration requires a GGUF file',
            path: ['resources', index, 'runtime', 'filePath']
          })
        }
        if (resource.files && !paths.has(resource.runtime.filePath)) {
          ctx.addIssue({
            code: 'custom',
            message: 'runtime file is absent from the locked file subset',
            path: ['resources', index, 'runtime', 'filePath']
          })
        }
      }
    }
  })

const searchQuery = z.object({
  kind: repoKind,
  search: z.string().max(256).optional(),
  author: z.string().max(128).optional(),
  // Generous cap: the dataset filter panel can legitimately stack many tag chips.
  tags: z.array(z.string().max(128)).max(48).optional(),
  pipelineTag: z.string().max(128).optional(),
  library: z.string().max(128).optional(),
  license: z.string().max(128).optional(),
  sort: z.enum(['trending', 'downloads', 'likes', 'updated', 'created']),
  inferenceProvider: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(4096).optional()
})

const repoSummary = z.object({
  id: repoId,
  kind: repoKind,
  author: z.string().max(128),
  name: z.string().max(256),
  likes: z.number(),
  downloads: z.number(),
  updatedAt: z.string().optional(),
  createdAt: z.string().optional(),
  private: z.boolean(),
  gated: z.union([z.string(), z.boolean()]),
  tags: z.array(z.string()).max(200),
  pipelineTag: z.string().optional(),
  libraryName: z.string().optional(),
  license: z.string().optional(),
  paramCount: z.number().optional(),
  sdk: z.string().optional(),
  trendingScore: z.number().optional()
})

const settingsPatch = z
  .object({
    locale: z.enum(['system', ...SUPPORTED_LOCALES]),
    theme: z.enum(['system', 'light', 'dark']),
    downloadConcurrency: z.number().int().min(1).max(8),
    speedLimitBps: z.number().int().min(1024).nullable(),
    notificationsEnabled: z.boolean(),
    pollIntervalMinutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    uiScale: z.number().int().min(80).max(140),
    hubEndpoint: z.union([z.url({ protocol: /^https?$/ }), z.null()]),
    proxyUrl: z.union([z.url({ protocol: /^https?$/ }), z.null()]),
    launchAtLogin: z.boolean(),
    closeToTray: z.boolean(),
    defaultHome: z.enum(['home', 'models', 'datasets', 'spaces', 'papers']),
    defaultRepoSort: z.enum(['trending', 'downloads', 'likes', 'updated', 'created']),
    uiDensity: z.enum(['comfortable', 'compact']),
    accent: z.enum(['default', 'blue', 'green', 'orange', 'violet']),
    fontScale: z.number().int().min(90).max(120),
    sidebarCollapsed: z.boolean(),
    browsePageSize: z.union([z.literal(20), z.literal(30), z.literal(50)]),
    repoOpenTarget: z.enum(['app', 'browser']),
    historyLimit: z.union([z.literal(50), z.literal(100), z.literal(200), z.literal(500)]),
    telemetryEnabled: z.boolean(),
    ollamaPort: z.number().int().min(1).max(65535)
  })
  .partial()
  .strict()

/** On-disk settings export envelope (import/export). */
export const settingsExportFileSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().min(1),
  settings: settingsPatch
})

const username = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.-]+$/, 'invalid username')

/** Collection API path segment: "owner/title-slug-<24hex>". */
const collectionSlug = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w.-]+\/[\w.-]*[0-9a-f]{24}$/, 'invalid collection slug')
  // The slug is interpolated raw into the API path; a dot-only owner segment
  // ("..") would traverse out of /api/collections/. Reject it like repo ids do.
  .refine((v) => v.split('/').every((segment) => !/^\.+$/.test(segment)), 'invalid collection slug')

/** 24-hex Mongo-style object id (collection items, watch targets, comment ids). */
const hexId = z.string().regex(/^[0-9a-f]{24}$/, 'invalid id')

const collectionNote = z.string().max(500)

const discussionNum = z.number().int().min(1)

const communityPromptClaimId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

/** Env-var style key for Space secrets and variables. */
const spaceEnvKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][_a-zA-Z0-9]*$/, 'invalid key')

/** Gated access requests only exist for models and datasets. */
const gatedRepoKind = z.enum(['model', 'dataset'])

// Watch targets are keyed by account handle (username/org name), not the
// 24-hex internal id — the Hub silently ignores id-based watch mutations.
const watchTargets = z
  .array(z.object({ id: username, type: z.enum(['user', 'org']) }))
  .min(1)
  .max(100)

/**
 * Validators for every channel that takes a payload. Channels with `req: void`
 * are validated by asserting the payload is undefined/null.
 */
export const ipcRequestSchemas: Partial<Record<IpcInvokeChannel, z.ZodTypeAny>> = {
  'system:openExternal': z.object({ url: z.url({ protocol: /^https?$/ }) }),
  'settings:set': z.object({ patch: settingsPatch }),
  'privacy:clearLocalData': z.object({
    favorites: z.boolean().optional(),
    history: z.boolean().optional(),
    downloads: z.boolean().optional(),
    follows: z.boolean().optional(),
    inbox: z.boolean().optional(),
    otherKv: z.boolean().optional(),
    signOut: z.boolean().optional()
  }),
  'telemetry:acknowledgeConsentPrompt': z
    .object({
      claimId: communityPromptClaimId
    })
    .strict(),
  'telemetry:resolveConsentPrompt': z
    .object({
      claimId: communityPromptClaimId,
      decision: z.literal('decline')
    })
    .strict(),
  'starReminder:acknowledgeShown': z
    .object({
      claimId: communityPromptClaimId
    })
    .strict(),
  'starReminder:respond': z
    .object({
      claimId: communityPromptClaimId,
      action: z.enum(['open', 'later', 'disable'])
    })
    .strict(),
  // Draft endpoint/proxy from Settings → Network "Test connection"; same URL
  // rules as the settings patch. Omitted fields fall back to applied settings.
  'network:testConnection': z
    .object({
      endpoint: z.union([z.url({ protocol: /^https?$/ }), z.null()]).optional(),
      proxyUrl: z.union([z.url({ protocol: /^https?$/ }), z.null()]).optional()
    })
    .optional(),
  // No hf_ prefix check: fine-grained/org tokens and mirror deployments vary.
  'auth:signInWithToken': z.object({ token: z.string().trim().min(1).max(512) }),
  'hub:search': z.object({ query: searchQuery }),
  'hub:papers': z.object({ cursor: z.string().max(4096).optional() }).optional(),
  'hub:paper': z.object({ paperId: z.string().min(1).max(128) }),
  'hub:repoDetail': z.object({ kind: repoKind, repoId, revision: revision.optional() }).strict(),
  'hub:repoRefs': z.object({ kind: repoKind, repoId }).strict(),
  'hub:repoCommits': z
    .object({
      kind: repoKind,
      repoId,
      revision: revision.optional(),
      cursor: z.string().max(4096).optional(),
      limit: z.number().int().min(1).max(100).optional()
    })
    .strict(),
  'hub:resolveRevision': z.object({ kind: repoKind, repoId, revision }).strict(),
  'hub:readme': z.object({ kind: repoKind, repoId, revision }).strict(),
  'hub:fileTree': z
    .object({
      kind: repoKind,
      repoId,
      revision,
      path: relPath.optional()
    })
    .strict(),
  'hub:discussions': z.object({
    kind: repoKind,
    repoId,
    type: z.enum(['discussion', 'pull_request']).optional(),
    status: z.enum(['open', 'closed']).optional(),
    cursor: z.string().max(4096).optional()
  }),
  'hub:discussionDiff': z.object({ kind: repoKind, repoId, num: z.number().int().min(1) }),
  'hub:posts': z.object({ cursor: z.string().max(4096).optional() }).optional(),
  'hub:recentActivity': z.object({ cursor: z.string().max(4096).optional() }).optional(),
  'hub:postDetail': z.object({
    author: z.string().min(1).max(128),
    slug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/)
  }),
  'hub:userOverview': z.object({
    username: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.-]+$/)
  }),
  'hub:userFollowing': z.object({
    username: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.-]+$/)
  }),
  'hub:orgMembers': z.object({
    org: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.-]+$/),
    limit: z.number().int().min(1).max(100).optional()
  }),
  'hub:discussionDetail': z.object({ kind: repoKind, repoId, num: z.number().int().min(1) }),
  'hub:discussionComment': z.object({
    kind: repoKind,
    repoId,
    num: z.number().int().min(1),
    comment: z.string().min(1).max(65536)
  }),
  'hub:discussionCreate': z.object({
    kind: repoKind,
    repoId,
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(65536),
    pullRequest: z.boolean().optional()
  }),
  'hub:fileText': z
    .object({
      kind: repoKind,
      repoId,
      path: relPath,
      revision,
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(8 * 1024 * 1024)
        .optional()
    })
    .strict(),
  'hub:fileRange': z
    .object({
      kind: repoKind,
      repoId,
      path: relPath,
      revision,
      start: z.number().int().min(0),
      end: z.number().int().min(0)
    })
    .strict()
    // Bound the window so a compromised renderer can't request a multi-GB slice
    // and OOM the main process. 64 MiB covers a parquet footer plus any single
    // column chunk a preview needs; larger asks fail clearly instead.
    .refine(
      (r) => r.end >= r.start && r.end - r.start < 64 * 1024 * 1024,
      'range window too large'
    ),
  'hub:safetensorsHeader': z
    .object({
      kind: repoKind,
      repoId,
      path: relPath,
      revision
    })
    .strict(),
  'hub:notifications': z
    .object({ page: z.number().int().min(0).max(10_000).optional() })
    .optional(),
  'hub:notificationsMarkRead': z.object({
    // Empty array = mark all notifications. Repo discussion ids are 24-hex but
    // post/blog/paper notification ids are plain strings, so stay permissive.
    discussionIds: z.array(z.string().min(1).max(64)).max(1000),
    read: z.boolean()
  }),
  'hub:watchUpdate': z.object({
    add: watchTargets.optional(),
    delete: watchTargets.optional()
  }),
  'hub:watchSet': z.object({
    // Account handle (username/org name), not the internal id.
    id: username,
    type: z.enum(['user', 'org']),
    watching: z.boolean()
  }),
  'hub:datasetSplits': z.object({ repoId }),
  'hub:datasetSampleRows': z.object({ repoId }),
  'hub:repoAccessGate': z.object({ kind: repoKind, repoId }),
  'hub:repoAccessAsk': z.object({
    kind: repoKind,
    repoId,
    // Field names are the verbatim gate questions (can be full sentences).
    fields: z.record(z.string().min(1).max(300), z.string().max(2000))
  }),
  'hub:searchUsers': z.object({ query: z.string().min(1).max(64) }),
  'hub:searchOrgs': z.object({ query: z.string().min(1).max(64) }),
  'hub:searchPapers': z.object({ query: z.string().min(1).max(64) }),
  'hub:searchCollections': z.object({ query: z.string().min(1).max(64) }),
  'hub:inferenceAvailable': z.object({ repoId }),
  'hub:modelEvalResults': z
    .object({
      repoId,
      revision,
      resolvedCommit: commitSha
    })
    .strict(),
  'hub:datasetLeaderboard': z
    .object({
      repoId,
      cursor: z.string().max(4096).optional(),
      limit: z.number().int().min(1).max(100).optional()
    })
    .strict(),
  'hub:collections': z.object({ owner: username }),
  'hub:collection': z.object({ slug: collectionSlug }),
  'hub:collectionCreate': z.object({
    namespace: username,
    title: z.string().min(1).max(60),
    description: z.string().max(150).optional(),
    private: z.boolean()
  }),
  'hub:collectionUpdate': z.object({
    slug: collectionSlug,
    patch: z.object({
      title: z.string().min(1).max(60).optional(),
      description: z.string().max(150).optional(),
      private: z.boolean().optional(),
      position: z.number().int().min(0).optional(),
      theme: z.string().max(64).optional()
    })
  }),
  'hub:collectionDelete': z
    .object({ slug: collectionSlug, confirmSlug: z.string().max(256) })
    .refine((v) => v.confirmSlug === v.slug, 'confirmation does not match'),
  'hub:collectionAddItem': z.object({
    slug: collectionSlug,
    item: z.object({
      type: z.enum(['model', 'dataset', 'space', 'paper']),
      id: z.string().min(1).max(256)
    }),
    note: collectionNote.optional()
  }),
  'hub:collectionUpdateItem': z.object({
    slug: collectionSlug,
    itemId: hexId,
    note: collectionNote.optional(),
    position: z.number().int().min(0).optional()
  }),
  'hub:collectionRemoveItem': z.object({ slug: collectionSlug, itemId: hexId }),
  'hub:repoSettingsUpdate': z.object({
    kind: repoKind,
    repoId,
    patch: z.object({
      private: z.boolean().optional(),
      gated: z.union([z.literal(false), z.enum(['auto', 'manual'])]).optional(),
      discussionsDisabled: z.boolean().optional()
    })
  }),
  'hub:repoMove': z.object({ kind: repoKind, fromRepo: repoId, toRepo: repoId }),
  'hub:repoDelete': z
    .object({ kind: repoKind, repoId, confirmName: z.string().max(256) })
    .refine((v) => v.confirmName === v.repoId, 'confirmation does not match'),
  'hub:repoDuplicate': z.object({
    repoId,
    toRepo: repoId,
    private: z.boolean().optional()
  }),
  'hub:branchCreate': z.object({
    kind: repoKind,
    repoId,
    branch: gitRefName,
    startingPoint: revision.optional()
  }),
  'hub:branchDelete': z.object({ kind: repoKind, repoId, branch: gitRefName }),
  'hub:tagCreate': z.object({
    kind: repoKind,
    repoId,
    tag: revision,
    revision: revision.optional(),
    message: z.string().max(500).optional()
  }),
  'hub:tagDelete': z.object({ kind: repoKind, repoId, tag: revision }),
  'hub:accessRequests': z.object({
    kind: gatedRepoKind,
    repoId,
    status: z.enum(['pending', 'accepted', 'rejected'])
  }),
  'hub:accessRequestHandle': z.object({
    kind: gatedRepoKind,
    repoId,
    user: username,
    status: z.enum(['accepted', 'rejected', 'pending']),
    rejectionReason: z.string().max(200).optional()
  }),
  'hub:accessRequestGrant': z.object({ kind: gatedRepoKind, repoId, user: username }),
  'hub:spaceSecrets': z.object({ repoId }),
  'hub:spaceSecretSet': z.object({
    repoId,
    key: spaceEnvKey,
    value: z.string().max(65536),
    description: z.string().max(500).optional()
  }),
  'hub:spaceSecretDelete': z.object({ repoId, key: spaceEnvKey }),
  'hub:spaceVariables': z.object({ repoId }),
  'hub:spaceVariableSet': z.object({
    repoId,
    key: spaceEnvKey,
    value: z.string().max(65536),
    description: z.string().max(500).optional()
  }),
  'hub:spaceVariableDelete': z.object({ repoId, key: spaceEnvKey }),
  'hub:spaceLogs': z.object({ repoId, logType: z.enum(['build', 'run']) }),
  'hub:spaceRestart': z.object({ repoId, factory: z.boolean().optional() }),
  'hub:likeSet': z.object({ kind: repoKind, repoId, liked: z.boolean() }),
  'hub:followSet': z.object({
    username,
    following: z.boolean(),
    isOrg: z.boolean().optional()
  }),
  'hub:userLikes': z.object({ username }),
  'hub:postComment': z.object({
    author: username,
    slug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/),
    comment: z.string().min(1).max(65536),
    replyToCommentId: hexId.optional()
  }),
  // 32-char cap: an emoji cluster with variation selectors/ZWJ stays well under it.
  'hub:postReactionSet': z.object({
    author: username,
    slug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/),
    reaction: z.string().min(1).max(32),
    active: z.boolean()
  }),
  'hub:postComments': z.object({
    author: username,
    slug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/)
  }),
  'hub:postCommentHide': z.object({
    author: username,
    slug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/),
    commentId: hexId,
    // Verbatim reason label; kept as a length-capped string (see HUB_HIDE_REASONS).
    reason: z.string().min(1).max(64).optional()
  }),
  // Field caps mirror the Hub's profile form (fullname maxlength=50; the rest generous).
  'hub:profileUpdate': z.object({
    fullname: z.string().max(50),
    homepage: z.string().max(300),
    details: z.string().max(2000),
    github: z.string().max(64),
    twitter: z.string().max(64),
    linkedin: z.string().max(128),
    bluesky: z.string().max(128),
    primaryOrg: z.string().max(128),
    avatar: z.string().max(500).optional()
  }),
  // 64 MB cap: comfortably covers image/audio/short-video attachments.
  'hub:commentAssetUpload': z.object({
    filename: z.string().min(1).max(256),
    contentType: z.string().min(1).max(128),
    data: z.instanceof(Uint8Array).refine((d) => d.byteLength <= 64 * 1024 * 1024, 'file too large')
  }),
  'hub:postCommentReactionSet': z.object({
    author: username,
    slug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/),
    commentId: hexId,
    reaction: z.string().min(1).max(32),
    active: z.boolean()
  }),
  'hub:postCreate': z.object({ content: z.string().min(1).max(65536) }),
  'hub:paperUpvoteSet': z.object({
    paperId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w.-]+$/, 'invalid paper id'),
    upvoted: z.boolean()
  }),
  'hub:collectionUpvoteSet': z.object({ slug: collectionSlug, upvoted: z.boolean() }),
  'hub:discussionReactionSet': z.object({
    kind: repoKind,
    repoId,
    num: discussionNum,
    commentId: hexId,
    reaction: z.string().min(1).max(32),
    active: z.boolean()
  }),
  'hub:paperComment': z.object({
    paperId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w.-]+$/, 'invalid paper id'),
    comment: z.string().min(1).max(65536),
    replyToCommentId: hexId.optional()
  }),
  'hub:paperComments': z.object({
    paperId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w.-]+$/, 'invalid paper id')
  }),
  'hub:paperCommentReactionSet': z.object({
    paperId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w.-]+$/, 'invalid paper id'),
    commentId: hexId,
    reaction: z.string().min(1).max(32),
    active: z.boolean()
  }),
  'hub:prMerge': z.object({
    kind: repoKind,
    repoId,
    num: discussionNum,
    comment: z.string().max(65536).optional()
  }),
  'hub:discussionStatusSet': z.object({
    kind: repoKind,
    repoId,
    num: discussionNum,
    status: z.enum(['open', 'closed']),
    comment: z.string().max(65536).optional()
  }),
  'hub:discussionTitleSet': z.object({
    kind: repoKind,
    repoId,
    num: discussionNum,
    title: z.string().min(3).max(200)
  }),
  'hub:datasetRows': z.object({
    repoId,
    config: z.string().min(1).max(256),
    split: z.string().min(1).max(256),
    offset: z.number().int().min(0).max(1_000_000).optional(),
    length: z.number().int().min(1).max(100).optional()
  }),
  'favorites:add': z.object({ summary: repoSummary }),
  'favorites:remove': z.object({ kind: repoKind, repoId }),
  'history:record': z.object({
    summary: repoSummary,
    revision: revision.optional(),
    resolvedCommit: commitSha.optional()
  }),
  'downloads:start': z
    .object({
      request: z
        .object({
          repoId,
          kind: repoKind,
          revision: revision.optional(),
          resolvedCommit: commitSha.optional(),
          files: z.array(relPath).max(10000).optional(),
          autoExport: z
            .object({
              tool: z.enum(['ollama', 'lmstudio', 'comfyui']),
              filePath: relPath
            })
            .strict()
            .optional(),
          postAction: downloadPostActionSchema.optional(),
          securityGrantId: uuid.optional()
        })
        .strict()
        .superRefine((request, ctx) => {
          if (request.autoExport && request.postAction) {
            ctx.addIssue({ code: 'custom', message: 'conflicting post actions' })
          }
          if (request.postAction && request.kind !== 'model') {
            ctx.addIssue({ code: 'custom', message: 'local run requires a model repository' })
          }
          for (const action of [request.autoExport, request.postAction]) {
            if (action && request.files && !request.files.includes(action.filePath)) {
              ctx.addIssue({
                code: 'custom',
                message: 'post-action file must be included in the download'
              })
            }
          }
        })
    })
    .strict(),
  'downloads:pause': z.object({ id: z.uuid() }),
  'downloads:resume': z.object({ id: z.uuid() }),
  'downloads:retryPostAction': z
    .object({
      id: z.uuid(),
      securityGrantId: uuid.optional(),
      allowTightFit: z.boolean().optional()
    })
    .strict(),
  'downloads:cancel': z.object({ id: z.uuid() }),
  'downloads:remove': z.object({ id: z.uuid() }),
  'downloads:reveal': z.object({ id: z.uuid() }),
  'hub:commitFiles': z
    .object({
      kind: repoKind,
      repoId,
      files: z
        .array(
          z
            .object({
              path: relPath,
              content: z.string().max(256 * 1024)
            })
            .strict()
        )
        .min(1)
        .max(5),
      title: z.string().min(1).max(200),
      description: z.string().max(4000).optional(),
      branch: gitRefName.optional(),
      startingPoint: commitSha,
      createPr: z.boolean().optional()
    })
    .strict()
    .superRefine((request, ctx) => {
      if (request.createPr !== true && !request.branch) {
        ctx.addIssue({
          code: 'custom',
          message: 'direct commit requires a branch',
          path: ['branch']
        })
      }
    }),
  'cache:snapshot': z.object({ kind: repoKind, repoId, commit: commitSha }).strict(),
  'cache:resolveFile': z
    .object({ kind: repoKind, repoId, commit: commitSha, path: relPath })
    .strict(),
  'cache:listPins': z
    .object({ kind: repoKind.optional(), repoId: repoId.optional() })
    .strict()
    .optional(),
  'cache:pin': z
    .object({
      kind: repoKind,
      repoId,
      commit: commitSha,
      label: z.string().max(256).optional()
    })
    .strict(),
  'cache:unpin': z.object({ kind: repoKind, repoId, commit: commitSha }).strict(),
  'cache:readText': z
    .object({
      kind: repoKind,
      repoId,
      path: relPath,
      commit: commitSha,
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(1024 * 1024)
        .optional()
    })
    .strict(),
  'cache:deleteRevisions': z
    .object({
      kind: repoKind,
      repoId,
      commitHashes: z
        .array(z.string().regex(/^[0-9a-f]{40}$/))
        .min(1)
        .max(100)
    })
    .strict(),
  'cache:cleanPartials': z.object({ kind: repoKind, repoId }).strict(),
  'cache:revealRepo': z.object({ kind: repoKind, repoId }).strict(),
  'follows:add': z.object({
    type: z.enum(['user', 'org', 'repo', 'papers']),
    target: z.string().max(300)
  }),
  'follows:remove': z.object({ id: z.uuid() }),
  'inbox:markRead': z.object({ ids: z.array(z.string()).min(1).max(1000) }),
  'export:start': z
    .object({
      request: z
        .object({
          tool: z.enum(['ollama', 'lmstudio', 'comfyui']),
          kind: repoKind,
          repoId,
          filePath: relPath,
          revision: revision.optional(),
          resolvedCommit: commitSha.optional(),
          securityGrantId: uuid.optional()
        })
        .strict()
    })
    .strict(),
  'export:cancel': z.object({ id: z.uuid() }),
  'upload:start': z.object({
    request: z.object({
      selectionId: z.uuid(),
      kind: repoKind,
      name: z.string().min(1).max(200),
      private: z.boolean(),
      acknowledgedWarningCodes: z.array(z.enum(['sensitive-path', 'large-upload'])).max(2)
    })
  }),
  'upload:cancel': z.object({ id: z.uuid() }),
  'integrationTasks:revealOutput': z.object({ id: z.uuid() }),
  'inference:run': z.object({
    request: z.object({ model: repoId, input: z.string().max(65536) })
  }),
  'inference:stream': z.object({
    id: z.uuid(),
    request: z.object({ model: repoId, input: z.string().max(65536) })
  }),
  'inference:cancel': z.object({ id: z.uuid() }),
  'security:preflight': z
    .object({
      request: z
        .object({
          action: securityAction,
          kind: repoKind,
          repoId,
          revision,
          resolvedCommit: commitSha,
          files: z.array(relPath).max(10_000).optional()
        })
        .strict()
    })
    .strict(),
  'security:confirm': z.object({ challengeId: uuid }).strict(),
  'localRuntime:selectBinary': z.object({ kind: localRuntimeKind }).strict(),
  'localRuntime:assess': z
    .object({
      runtime: localRuntimeKind,
      fileSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      contextLength: z.number().int().min(128).max(1_048_576),
      layerCount: z.number().int().min(1).max(10_000).optional(),
      embeddingLength: z.number().int().min(1).max(1_000_000).optional(),
      kvHeadCount: z.number().int().min(1).max(100_000).optional(),
      cached: z.boolean().optional(),
      importedAlready: z.boolean().optional()
    })
    .strict(),
  'localRuntime:inspectCachedGguf': z
    .object({
      repoId,
      resolvedCommit: commitSha,
      filePath: relPath
    })
    .strict(),
  'localRuntime:presets': z.object({ repoId, resolvedCommit: commitSha }).strict(),
  'localRuntime:start': z
    .object({
      request: z
        .object({
          runtime: localRuntimeKind,
          repoId,
          revision,
          resolvedCommit: commitSha,
          filePath: relPath,
          contextLength: z.number().int().min(128).max(1_048_576).optional(),
          maxTokens: z.number().int().min(1).max(32_768).optional(),
          temperature: z.number().min(0).max(2).optional(),
          gpuLayers: z.union([z.literal('auto'), z.number().int().min(0).max(1000)]).optional(),
          securityGrantId: uuid.optional(),
          allowTightFit: z.boolean().optional()
        })
        .strict()
    })
    .strict(),
  'localRuntime:chatStream': z
    .object({
      id: uuid,
      request: z
        .object({
          messages: z
            .array(
              z
                .object({
                  role: z.enum(['system', 'user', 'assistant']),
                  content: z.string().max(65_536)
                })
                .strict()
            )
            .min(1)
            .max(256),
          maxTokens: z.number().int().min(1).max(32_768).optional(),
          temperature: z.number().min(0).max(2).optional()
        })
        .strict()
    })
    .strict(),
  'localRuntime:cancel': z.object({ id: uuid }).strict(),
  'localRuntime:removeImportedModel': z.object({ modelName: z.string().min(1).max(256) }).strict(),
  'lockfile:export': z.object({ lock: ohmyhfLockV1Schema }).strict(),
  'lockfile:confirmEndpoint': z.object({ inspectionId: uuid }).strict(),
  'lockfile:confirmSecurity': z
    .object({
      inspectionId: uuid,
      resourceIndex: z.number().int().min(0).max(99),
      challengeId: uuid
    })
    .strict(),
  'lockfile:restore': z
    .object({
      inspectionId: uuid,
      confirmEndpoint: z.boolean().optional(),
      securityGrantIds: z.array(uuid).max(100).optional()
    })
    .strict()
}
