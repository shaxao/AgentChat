import { useState, useEffect, lazy, Suspense } from 'react'
import { useAuthStore } from '@/store'
import { ThemeProvider } from '@/components/ThemeProvider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from 'sonner'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard'
import IconNavBar, { type MainView } from '@/components/layout/IconNavBar'
import MobileBottomNav from '@/components/layout/MobileBottomNav'
import { rbacApi } from '@/lib/api'

export type AppPage = MainView

const LoginPage = lazy(() => import('@/pages/LoginPage'))
const ChatPage = lazy(() => import('@/pages/ChatPage'))
const AutoCodePage = lazy(() => import('@/pages/AutoCodePage'))
const ModelRoutingPage = lazy(() => import('@/pages/ModelRoutingPage'))
const SkillStoreView = lazy(() => import('@/components/skill/SkillStoreView'))
const WalletPage = lazy(() => import('@/pages/WalletPage'))
const ScenarioSquarePage = lazy(() => import('@/pages/ScenarioSquarePage'))
const WorkflowPage = lazy(() => import('@/pages/WorkflowPage'))
const WorkflowTemplatePage = lazy(() => import('@/pages/WorkflowTemplatePage'))
const AdminPage = lazy(() => import('@/pages/AdminPage'))
const SubscriptionPage = lazy(() => import('@/pages/SubscriptionPage'))
const MemoryTimelinePage = lazy(() => import('@/pages/MemoryTimelinePage'))
const ApiDocsPage = lazy(() => import('@/pages/ApiDocsPage'))
const SettingsDialog = lazy(() => import('@/components/settings/SettingsDialog'))
const HarnessEvolutionTab = lazy(() => import('@/components/admin/HarnessEvolutionTab'))

function PageLoading() {
  return (
    <div className="h-full w-full bg-background p-4 md:p-6">
      <div className="mx-auto flex h-full max-w-6xl flex-col gap-4">
        <div className="h-9 w-48 animate-pulse rounded-md bg-muted" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div key={idx} className="h-24 animate-pulse rounded-lg border bg-muted/35" />
          ))}
        </div>
        <div className="min-h-0 flex-1 animate-pulse rounded-lg border bg-muted/25" />
      </div>
    </div>
  )
}

export default function App() {
  const { isAuthenticated, user, permissions, setPermissions } = useAuthStore()
  const path = window.location.pathname.toLowerCase()
  const isMobile = useIsMobile()
  const { keyboardOpen } = useMobileKeyboard()
  const getInitialView = (): MainView => {
    const path = window.location.pathname.toLowerCase()
    const view = new URLSearchParams(window.location.search).get('view')
    if (view === 'autocode') return 'autocode'
    if (path === '/aucode' || path.startsWith('/aucode/') || path === '/autocode' || path.startsWith('/autocode/')) {
      return 'autocode'
    }
    return 'chat'
  }
  const [activeView, setActiveView] = useState<MainView>(getInitialView)
  const [adminMode, setAdminMode] = useState(false)
  const [subscriptionMode, setSubscriptionMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showMemoryTimeline, setShowMemoryTimeline] = useState(false)

  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin'
  const canOpenAdmin = isAdmin

  // 键盘打开时阻止浏览器自动滚动页面（移动端聚焦输入框时常见问题）
  useEffect(() => {
    if (!isMobile || !keyboardOpen) return

    const vv = window.visualViewport
    if (!vv) return

    const handleViewportScroll = () => {
      // 浏览器聚焦输入框时会自动滚动页面，导致页面上下跳动
      // 通过重置 scrollY 抵消此行为
      if (window.scrollY > 0) {
        window.scrollTo(0, 0)
      }
    }

    vv.addEventListener('scroll', handleViewportScroll)
    // 立即执行一次，防止键盘刚打开时的初始偏移
    handleViewportScroll()

    // iOS Safari 下 overflow:hidden 不足以阻止触摸滚动，需要 position:fixed
    const body = document.body
    const originalPosition = body.style.position
    const originalTop = body.style.top
    const originalLeft = body.style.left
    const originalWidth = body.style.width
    body.style.position = 'fixed'
    body.style.top = '0'
    body.style.left = '0'
    body.style.width = '100%'

    return () => {
      vv.removeEventListener('scroll', handleViewportScroll)
      body.style.position = originalPosition
      body.style.top = originalTop
      body.style.left = originalLeft
      body.style.width = originalWidth
    }
  }, [isMobile, keyboardOpen])

  const handleOpenAdmin = () => {
    if (canOpenAdmin) setAdminMode(true)
  }

  useEffect(() => {
    const path = window.location.pathname.toLowerCase()
    const view = new URLSearchParams(window.location.search).get('view')
    if (view === 'autocode') {
      setActiveView('autocode')
      return
    }
    if (path === '/aucode' || path.startsWith('/aucode/') || path === '/autocode' || path.startsWith('/autocode/')) {
      setActiveView('autocode')
    }
  }, [])

  useEffect(() => {
    if (!isAuthenticated) return
    rbacApi.getMyPermissions()
      .then(setPermissions)
      .catch(() => {})
  }, [isAuthenticated, setPermissions])

  if (path === '/api-docs' || path === '/docs/api') {
    return (
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <Toaster position="top-center" richColors />
          <Suspense fallback={<PageLoading />}>
            <ApiDocsPage />
          </Suspense>
        </TooltipProvider>
      </ThemeProvider>
    )
  }

  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        <Toaster position="top-center" richColors />
        {isAuthenticated ? (
          <div className="app-viewport flex flex-col overflow-hidden">
            {/* 顶部栏：桌面端无，移动端可在此加汉堡菜单（暂用 bottom nav 替代） */}
            
            <div className="flex min-h-0 flex-1 overflow-hidden">
              {/* 左侧图标导航栏 — 仅桌面端显示 */}
              <IconNavBar
                activeView={activeView}
                onChange={setActiveView}
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenAdmin={handleOpenAdmin}
                isAdmin={canOpenAdmin}
              />

              {/* 主内容区 — 键盘打开时移除底部导航预留空间，实现无缝衔接 */}
              <div className="app-content relative min-h-0 flex-1 overflow-hidden">
                <Suspense fallback={<PageLoading />}>
                  {showMemoryTimeline ? (
                    /* 记忆时间线全屏覆盖 - 优先显示，不渲染其他页面避免 effect 冲突 */
                    <MemoryTimelinePage onBack={() => setShowMemoryTimeline(false)} />
                  ) : (
                    <>
                      {canOpenAdmin && adminMode && <AdminPage onBack={() => setAdminMode(false)} />}
                      {subscriptionMode && <SubscriptionPage onBack={() => setSubscriptionMode(false)} />}

                      {!adminMode && !subscriptionMode && (
                        <>
                          {activeView === 'chat' && (
                            <ChatPage
                              onOpenAdmin={handleOpenAdmin}
                              onOpenSettings={() => setSettingsOpen(true)}
                              onOpenSubscription={() => setSubscriptionMode(true)}
                              onOpenSkillStore={() => setActiveView('skill-store')}
                              onNavigate={(v: MainView) => setActiveView(v)}
                              onViewTimeline={() => setShowMemoryTimeline(true)}
                            />
                          )}
                          {activeView === 'skill-store' && <SkillStoreView onNavigate={setActiveView} />}
                          {activeView === 'autocode' && <AutoCodePage onNavigate={setActiveView} />}
                          {activeView === 'routing' && <ModelRoutingPage />}
                          {activeView === 'scenarios' && <ScenarioSquarePage onNavigate={(v: MainView) => setActiveView(v)} />}
                          {activeView === 'wallet' && <WalletPage onNavigate={setActiveView} />}
                          {activeView === 'workflow' && <WorkflowPage />}
                          {activeView === 'templates' && <WorkflowTemplatePage />}
                          {activeView === 'harness' && <HarnessEvolutionTab />}
                        </>
                      )}
                    </>
                  )}
                </Suspense>
              </div>

              <Suspense fallback={null}>
                <SettingsDialog
                  open={settingsOpen}
                  onClose={() => setSettingsOpen(false)}
                  onOpenSubscription={() => setSubscriptionMode(true)}
                />
              </Suspense>
            </div>

            {/* 移动端底部导航栏 — 键盘打开时隐藏 */}
            {!keyboardOpen && (
              <MobileBottomNav
                activeView={activeView}
                onChange={setActiveView}
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenAdmin={handleOpenAdmin}
                isAdmin={canOpenAdmin}
              />
            )}
          </div>
        ) : (
          <Suspense fallback={<PageLoading />}>
            <LoginPage />
          </Suspense>
        )}
      </TooltipProvider>
    </ThemeProvider>
  )
}
