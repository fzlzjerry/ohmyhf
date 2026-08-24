import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import type { DefaultHome } from '@oh-my-huggingface/shared'
import { queryClient } from '@/lib/query'
import { useAppStore } from '@/stores/app'
import { AppShell } from '@/components/layout/AppShell'
import { ErrorBoundary } from '@/components/errors/ErrorBoundary'
import { BrowsePage } from '@/pages/BrowsePage'
import { CachePage } from '@/pages/CachePage'
import { CollectionPage } from '@/pages/CollectionPage'
import { CollectionsPage } from '@/pages/CollectionsPage'
import { ComparePage } from '@/pages/ComparePage'
import { DownloadsPage } from '@/pages/DownloadsPage'
import { FavoritesPage } from '@/pages/FavoritesPage'
import { HistoryPage } from '@/pages/HistoryPage'
import { LeaderboardPage } from '@/pages/LeaderboardPage'
import { HomePage } from '@/pages/HomePage'
import { InboxPage } from '@/pages/InboxPage'
import { MyReposPage } from '@/pages/MyReposPage'
import { PapersPage } from '@/pages/PapersPage'
import { PostPage } from '@/pages/PostPage'
import { SearchPage } from '@/pages/SearchPage'
import { UploadPage } from '@/pages/UploadPage'
import { UserPage } from '@/pages/UserPage'

const HOME_PATH: Record<DefaultHome, string> = {
  home: '/',
  models: '/models',
  datasets: '/datasets',
  spaces: '/spaces',
  papers: '/papers'
}

function DefaultHomeRedirect(): React.JSX.Element {
  const home = useAppStore((s) => s.settings.defaultHome)
  if (home === 'home') return <HomePage />
  return <Navigate to={HOME_PATH[home]} replace />
}

export function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<DefaultHomeRedirect />} />
              <Route path="models/*" element={<BrowsePage kind="model" />} />
              <Route path="datasets/*" element={<BrowsePage kind="dataset" />} />
              <Route path="spaces/*" element={<BrowsePage kind="space" />} />
              <Route path="papers/*" element={<PapersPage />} />
              <Route path="posts/:author/:slug" element={<PostPage />} />
              <Route path="users/:username" element={<UserPage />} />
              <Route path="favorites" element={<FavoritesPage />} />
              <Route path="history" element={<HistoryPage />} />
              <Route path="my-repos" element={<MyReposPage />} />
              <Route path="collections" element={<CollectionsPage />} />
              {/* Collection slugs contain a slash (owner/name-id), hence the splat. */}
              <Route path="collections/*" element={<CollectionPage />} />
              <Route path="downloads" element={<DownloadsPage />} />
              <Route path="cache" element={<CachePage />} />
              <Route path="inbox" element={<InboxPage />} />
              <Route path="compare" element={<ComparePage />} />
              <Route path="leaderboards/*" element={<LeaderboardPage />} />
              <Route path="upload" element={<UploadPage />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </HashRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
