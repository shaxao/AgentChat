import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  MessageSquare, BookOpen, Code2, Wallet, Settings, User, GitBranch, LayoutGrid, Workflow, Layers, Activity,
} from 'lucide-react'
import NotificationBell from './NotificationBell'

export type MainView = 'chat' | 'skill-store' | 'autocode' | 'wallet' | 'routing' | 'scenarios' | 'workflow' | 'templates' | 'harness'

interface IconNavBarProps {
  activeView: MainView
  onChange: (v: MainView) => void
  onOpenSettings: () => void
  onOpenAdmin: () => void
  isAdmin?: boolean
}

interface NavItem {
  id: MainView
  icon: React.ReactNode
  label: string
  adminOnly?: boolean
}

export default function IconNavBar({ activeView, onChange, onOpenSettings, onOpenAdmin, isAdmin }: IconNavBarProps) {
  const navItems: NavItem[] = [
    { id: 'chat', icon: <MessageSquare className="w-5 h-5" />, label: '对话' },
    { id: 'skill-store', icon: <BookOpen className="w-5 h-5" />, label: '技能商店' },
    { id: 'autocode', icon: <Code2 className="w-5 h-5" />, label: '代码开发' },
    { id: 'scenarios', icon: <LayoutGrid className="w-5 h-5" />, label: '场景广场' },
    { id: 'workflow', icon: <Workflow className="w-5 h-5" />, label: '工作流' },
    { id: 'templates', icon: <Layers className="w-5 h-5" />, label: '模板市场' },
    { id: 'harness', icon: <Activity className="w-5 h-5" />, label: 'Harness 演进' },
    { id: 'routing', icon: <GitBranch className="w-5 h-5" />, label: '模型路由' },
    { id: 'wallet', icon: <Wallet className="w-5 h-5" />, label: '钱包' },
  ]

  return (
    <div className="hidden md:flex w-14 flex-col items-center py-3 border-r bg-sidebar/50 select-none shrink-0">
      {/* Logo - 品牌标识（放大展示） */}
      <div className="w-11 h-11 rounded-xl bg-white dark:bg-sidebar flex items-center justify-center mb-5 shrink-0 overflow-hidden border border-border/40 shadow-sm">
        <img src="/logo.png" alt="木火智能对话" className="w-full h-full object-cover" />
      </div>

      {/* Main nav items */}
      <div className="flex flex-col items-center gap-2 flex-1">
        {navItems.map((item) => (
          <Tooltip key={item.id} delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                onClick={() => onChange(item.id)}
                className={cn(
                  'w-10 h-10 rounded-xl flex items-center justify-center transition-all',
                  activeView === item.id
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground'
                )}
                title={item.label}
              >
                {item.icon}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      {/* Bottom actions */}
      <div className="flex flex-col items-center gap-2 mt-auto">
        {/* 通知铃铛 */}
        <NotificationBell compact />

        {isAdmin && (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenAdmin}
                className="w-10 h-10 rounded-xl flex items-center justify-center transition-all text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
              >
                <Settings className="w-5 h-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">管理</TooltipContent>
          </Tooltip>
        )}

        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              onClick={onOpenSettings}
              className="w-10 h-10 rounded-xl flex items-center justify-center transition-all text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
            >
              <User className="w-5 h-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">设置</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
