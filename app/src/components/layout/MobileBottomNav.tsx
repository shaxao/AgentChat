import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { MainView } from '@/components/layout/IconNavBar'
import {
  MessageSquare, BookOpen, Code2, Wallet, GitBranch, LayoutGrid, Workflow, Layers,
  MoreHorizontal, Settings, Shield, X, Bell, Activity
} from 'lucide-react'
import NotificationBell from './NotificationBell'

interface MobileBottomNavProps {
  activeView: MainView
  onChange: (v: MainView) => void
  onOpenSettings?: () => void
  onOpenAdmin?: () => void
  isAdmin?: boolean
}

const coreItems = [
  { id: 'chat' as MainView, Icon: MessageSquare, label: '对话' },
  { id: 'skill-store' as MainView, Icon: BookOpen, label: '技能' },
  { id: 'scenarios' as MainView, Icon: LayoutGrid, label: '场景' },
  { id: 'autocode' as MainView, Icon: Code2, label: '开发' },
]

const moreItems = [
  { id: 'templates' as MainView, Icon: Layers, label: '模板' },
  { id: 'workflow' as MainView, Icon: Workflow, label: '工作流' },
  { id: 'harness' as MainView, Icon: Activity, label: 'Harness' },
  { id: 'routing' as MainView, Icon: GitBranch, label: '路由' },
  { id: 'wallet' as MainView, Icon: Wallet, label: '钱包' },
]

export default function MobileBottomNav({ activeView, onChange, onOpenSettings, onOpenAdmin, isAdmin }: MobileBottomNavProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const isMoreActive = moreItems.some(item => item.id === activeView)

  const handleNavClick = (id: MainView) => {
    onChange(id)
    setMoreOpen(false)
  }

  return (
    <>
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur-md border-t"
        style={{ bottom: 'var(--mobile-browser-bottom)', paddingBottom: 'var(--mobile-safe-bottom)' }}
      >
        <div className="flex items-center h-14 gap-0.5 px-1">
          {coreItems.map((item) => (
            <button
              key={item.id}
              onClick={() => handleNavClick(item.id)}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 flex-1 px-1 py-1 transition-colors',
                activeView === item.id
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <item.Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium leading-none whitespace-nowrap">{item.label}</span>
            </button>
          ))}

          <button
            onClick={() => setMoreOpen(true)}
            className={cn(
              'flex flex-col items-center justify-center gap-0.5 flex-1 px-1 py-1 transition-colors',
              isMoreActive
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <MoreHorizontal className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-none whitespace-nowrap">更多</span>
          </button>
        </div>
      </nav>

      {/* 更多菜单面板 */}
      <div
        className={cn(
          'fixed inset-0 z-[60] flex flex-col justify-end transition-opacity duration-200',
          moreOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        )}
        onClick={() => setMoreOpen(false)}
      >
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
        <div
          className={cn(
            'relative bg-background rounded-t-2xl p-4 shadow-2xl border-t transition-transform duration-300',
            moreOpen ? 'translate-y-0' : 'translate-y-full'
          )}
          onClick={(e) => e.stopPropagation()}
          style={{ paddingBottom: 'max(2rem, env(safe-area-inset-bottom, 8px))' }}
        >
          <div className="flex justify-center mb-3">
            <div className="w-8 h-1 rounded-full bg-muted-foreground/30" />
          </div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">更多功能</h3>
            <button
              onClick={() => setMoreOpen(false)}
              className="p-1 rounded-full hover:bg-muted transition-colors"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {moreItems.map((item) => (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className={cn(
                  'flex flex-col items-center gap-2 p-3 rounded-xl transition-colors',
                  activeView === item.id
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                )}
              >
                <item.Icon className="w-6 h-6" />
                <span className="text-xs font-medium">{item.label}</span>
              </button>
            ))}
            {/* 通知铃铛 */}
            <div className="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
              <NotificationBell onOpen={() => setMoreOpen(false)} />
              <span className="text-xs font-medium">通知</span>
            </div>
            {isAdmin && (
              <button
                onClick={() => {
                  onOpenAdmin?.()
                  setMoreOpen(false)
                }}
                className="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <Shield className="w-6 h-6" />
                <span className="text-xs font-medium">管理</span>
              </button>
            )}
            <button
              onClick={() => {
                onOpenSettings?.()
                setMoreOpen(false)
              }}
              className="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <Settings className="w-6 h-6" />
              <span className="text-xs font-medium">设置</span>
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
