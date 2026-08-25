import { useQuery } from '@tanstack/react-query'
import type { DownloadCapacity } from '@oh-my-huggingface/shared'
import { invoke } from '@/lib/ipc'
import { useAppStore } from '@/stores/app'

export const DOWNLOAD_CAPACITY_QUERY_KEY = ['download-capacity'] as const

export function estimatedWriteBytes(
  sourceBytes: number | undefined,
  capacity: DownloadCapacity | undefined
): number | undefined {
  if (sourceBytes === undefined) return undefined
  return Math.min(Number.MAX_SAFE_INTEGER, sourceBytes * (capacity?.writeMultiplier ?? 1))
}

export function downloadBlockedByCapacity(
  requiredBytes: number | undefined,
  capacity: DownloadCapacity | undefined
): boolean {
  return (
    requiredBytes !== undefined &&
    capacity?.availableBytes !== undefined &&
    requiredBytes > capacity.availableBytes
  )
}

export function isDiskCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /download\.diskInsufficient|ENOSPC|no space left|disk full/i.test(message)
}

export function useDownloadCapacity(): ReturnType<typeof useQuery<DownloadCapacity>> {
  const cacheDir = useAppStore((state) => state.settings.hfCacheDir)
  return useQuery({
    queryKey: [...DOWNLOAD_CAPACITY_QUERY_KEY, cacheDir ?? 'default'],
    queryFn: () => invoke('downloads:getCapacity', undefined),
    staleTime: 10_000,
    refetchInterval: 10_000
  })
}
