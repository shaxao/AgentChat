import { useState, useMemo, useEffect } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { Globe, Server, Smartphone, Wrench, Loader2, Sparkles, Cpu, FileText, ListChecks } from 'lucide-react'
import { useAvailableModels } from '@/hooks/useAvailableModels'

export interface NewTaskParams {
  title: string
  description: string
  projectType: string
  techStack: string
  model?: string
  spec?: string
  enableSmartPlanning?: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  onSubmit: (params: NewTaskParams) => Promise<void>
}

const PROJECT_TYPES = [
  {
    id: 'website',
    icon: Globe,
    label: '网站开发',
    desc: 'React / Next.js / Vue',
    color: 'text-blue-500',
    bg: 'bg-blue-500/10 hover:bg-blue-500/20 border-blue-500/20',
    activeBg: 'bg-blue-500/20 border-blue-500',
  },
  {
    id: 'api',
    icon: Server,
    label: 'API 服务',
    desc: 'FastAPI / Express / Spring',
    color: 'text-green-500',
    bg: 'bg-green-500/10 hover:bg-green-500/20 border-green-500/20',
    activeBg: 'bg-green-500/20 border-green-500',
  },
  {
    id: 'miniapp',
    icon: Smartphone,
    label: '小程序',
    desc: '微信 / UniApp',
    color: 'text-purple-500',
    bg: 'bg-purple-500/10 hover:bg-purple-500/20 border-purple-500/20',
    activeBg: 'bg-purple-500/20 border-purple-500',
  },
  {
    id: 'tool',
    icon: Wrench,
    label: '工具脚本',
    desc: 'Python / Node.js / Shell',
    color: 'text-orange-500',
    bg: 'bg-orange-500/10 hover:bg-orange-500/20 border-orange-500/20',
    activeBg: 'bg-orange-500/20 border-orange-500',
  },
]

const TECH_STACKS: Record<string, string[]> = {
  website: ['Next.js + TypeScript', 'React + Vite', 'Vue 3 + Vite', 'Nuxt.js', 'Astro'],
  api: ['FastAPI + Python', 'Express + Node.js', 'Spring Boot', 'NestJS', 'Gin + Go'],
  miniapp: ['微信原生', 'UniApp + Vue3', 'Taro + React'],
  tool: ['Python 3', 'Node.js', 'Shell Script', 'PowerShell', 'Go'],
}

const QUICK_PROMPTS: Record<string, string[]> = {
  website: [
    '企业官网，包含首页、产品介绍、关于我们、联系我们页面',
    'SaaS 产品落地页，包含功能展示、定价、客户案例和 FAQ',
    '个人博客，支持 Markdown，包含文章列表、详情页和标签筛选',
    '电商网站，包含商品列表、购物车和结算流程',
  ],
  api: [
    'RESTful 用户认证 API，包含注册、登录、JWT 鉴权和用户资料',
    '文件上传下载 API，支持分片上传和断点续传',
    '商品管理 CRUD API，包含分页、搜索和分类筛选',
  ],
  miniapp: [
    '餐厅点餐小程序，包含菜单、购物车、下单和订单状态',
    '健身打卡小程序，记录运动、日历展示和分享海报',
  ],
  tool: [
    '批量图片压缩脚本，支持 JPG/PNG，保持比例并输出报告',
    'Excel 数据处理脚本，读取、清洗、转换并导出 CSV',
    'API 接口测试工具，支持 HTTP 请求、断言和报告生成',
  ],
}

const SPEC_EXAMPLES = [
  { label: 'UI 规范', value: '使用 Tailwind CSS，界面克制清爽，支持响应式布局和深色模式。' },
  { label: '代码规范', value: 'TypeScript 严格模式，组件使用函数式写法，文件命名使用 kebab-case。' },
  { label: '架构规范', value: '前后端边界清晰，重要配置放入环境变量，保留可运行的验证命令。' },
]

export default function NewTaskDialog({ open, onClose, onSubmit }: Props) {
  const { models: toolModels } = useAvailableModels({ requiredCapabilities: ['tool'] })
  const [projectType, setProjectType] = useState('website')
  const [techStack, setTechStack] = useState('Next.js + TypeScript')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [model, setModel] = useState('auto')
  const [spec, setSpec] = useState('')
  const [showSpec, setShowSpec] = useState(false)
  const [enableSmartPlanning, setEnableSmartPlanning] = useState(false)
  const [loading, setLoading] = useState(false)

  const availableModels = useMemo(() => {
    return [{ id: 'auto', name: 'Auto（智能路由）', capabilities: ['tool'] }, ...toolModels]
  }, [toolModels])

  useEffect(() => {
    if (!availableModels.some(m => m.id === model)) {
      setModel('auto')
    }
  }, [availableModels, model])

  const handleTypeChange = (type: string) => {
    setProjectType(type)
    setTechStack(TECH_STACKS[type][0])
  }

  const handleSubmit = async () => {
    if (!description.trim()) return
    setLoading(true)
    try {
      await onSubmit({
        title: title.trim() || description.slice(0, 40),
        description: description.trim(),
        projectType,
        techStack,
        model: model === 'auto' ? undefined : model,
        spec: spec.trim() || undefined,
        enableSmartPlanning,
      })
      setTitle('')
      setDescription('')
      setProjectType('website')
      setTechStack('Next.js + TypeScript')
      setModel('auto')
      setSpec('')
      setShowSpec(false)
      setEnableSmartPlanning(false)
      onClose()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[95vw] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="w-5 h-5 text-primary" />
            新建开发任务
          </DialogTitle>
          <DialogDescription>
            描述目标和约束后，AutoCode 会以 Agentic Loop 自主检索、修改和验证；智能规划默认关闭，可按需作为上下文提示开启。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div>
            <label className="text-sm font-medium text-foreground mb-2 block">项目类型</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {PROJECT_TYPES.map((pt) => {
                const Icon = pt.icon
                const isActive = projectType === pt.id
                return (
                  <button
                    key={pt.id}
                    onClick={() => handleTypeChange(pt.id)}
                    className={cn(
                      'flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-all',
                      isActive ? pt.activeBg : pt.bg
                    )}
                  >
                    <Icon className={cn('w-6 h-6', pt.color)} />
                    <span className="text-xs font-semibold">{pt.label}</span>
                    <span className="text-[10px] text-muted-foreground leading-tight">{pt.desc}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-foreground mb-2 block">技术栈</label>
            <div className="flex flex-wrap gap-1.5">
              {TECH_STACKS[projectType].map((stack) => (
                <Badge
                  key={stack}
                  variant={techStack === stack ? 'default' : 'outline'}
                  className="cursor-pointer select-none px-2.5 py-1 text-xs transition-colors"
                  onClick={() => setTechStack(stack)}
                >
                  {stack}
                </Badge>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-primary" />
              AI 模型
            </label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map(m => (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="flex items-center gap-2">
                      <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
                      {m.name}
                      {m.id === 'auto' && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">推荐</span>}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-muted-foreground">仅显示支持工具调用的模型，确保 Agent 可以读取文件、修改代码并运行验证。</p>
          </div>

          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <label htmlFor="smart-planning" className="flex items-center gap-1.5 text-sm font-medium">
                  <ListChecks className="w-3.5 h-3.5 text-primary" />
                  启用智能规划
                </label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  关闭时直接进入自主开发；开启时先生成可审查计划，但计划只作为护栏和上下文，不再固定驱动每一步。
                </p>
              </div>
              <Switch id="smart-planning" checked={enableSmartPlanning} onCheckedChange={setEnableSmartPlanning} />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 block">
              项目标题 <span className="font-normal text-muted-foreground">（选填）</span>
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="不填则自动从描述生成"
              className="h-9"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 block">
              项目描述 <span className="text-destructive">*</span>
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="描述你想开发的功能、页面、约束、已有问题或期望输出..."
              rows={4}
              className="resize-none text-sm"
            />
          </div>

          <div>
            <button
              onClick={() => setShowSpec(!showSpec)}
              className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-primary"
            >
              <FileText className="w-3.5 h-3.5 text-primary" />
              开发规范
              <span className="text-xs font-normal text-muted-foreground">（选填）</span>
              <Badge variant="outline" className="ml-1 px-1.5 py-0 text-[9px]">SPEC</Badge>
            </button>
            {showSpec && (
              <div className="space-y-2">
                <Textarea
                  value={spec}
                  onChange={(e) => setSpec(e.target.value)}
                  placeholder="定义编码规范、UI 设计规范、架构要求、测试要求等，Agent 会作为约束遵循。"
                  rows={3}
                  className="resize-none font-mono text-sm"
                />
                <div className="flex flex-wrap gap-1.5">
                  {SPEC_EXAMPLES.map(ex => (
                    <button
                      key={ex.label}
                      onClick={() => setSpec(ex.value)}
                      className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              快速描述示例
            </label>
            <div className="space-y-1.5">
              {QUICK_PROMPTS[projectType].map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => setDescription(prompt)}
                  className="w-full rounded-lg border border-border px-3 py-2 text-left text-xs text-muted-foreground transition-all hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>取消</Button>
          <Button
            onClick={handleSubmit}
            disabled={!description.trim() || loading}
            className="min-w-[120px] gap-2"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" />启动中...</>
            ) : (
              <><Sparkles className="w-4 h-4" />开始开发</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
