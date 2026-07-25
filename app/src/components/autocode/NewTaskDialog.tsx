import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Code2, Cpu, FileSpreadsheet, FileText, ListChecks, Loader2, Presentation, Sparkles } from 'lucide-react'
import { useAvailableModels } from '@/hooks/useAvailableModels'
import { useChatStore } from '@/store'

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

const TASK_EXAMPLES = [
  {
    icon: Code2,
    label: '软件开发',
    prompt: '分析当前项目并实现用户登录功能，完成必要测试和验证。',
  },
  {
    icon: Presentation,
    label: '演示文稿',
    prompt: '创建一份产品季度复盘 PPTX，包含关键指标、问题分析和下季度计划。',
  },
  {
    icon: FileSpreadsheet,
    label: '数据表格',
    prompt: '整理附件中的销售数据并生成 XLSX，保留公式、汇总表和清晰格式。',
  },
  {
    icon: FileText,
    label: '文档与文件',
    prompt: '根据需求生成可交付的文档或文件，并检查格式、内容和可打开性。',
  },
]

const SPEC_EXAMPLES = [
  '优先复用现有项目结构，避免无关重构；完成后运行与真实产物匹配的验证。',
  '所有文本使用 UTF-8；保留中文内容；遇到缺少工具时明确说明能力缺口。',
  '只修改需求涉及的文件，并在最终说明中列出产物、验证结果和未完成项。',
]

export default function NewTaskDialog({ open, onClose, onSubmit }: Props) {
  const { models: toolModels } = useAvailableModels({ requiredCapabilities: ['tool'] })
  const selectedModel = useChatStore(state => state.selectedModel)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [executionHint, setExecutionHint] = useState('')
  const [model, setModel] = useState('auto')
  const [spec, setSpec] = useState('')
  const [showSpec, setShowSpec] = useState(false)
  const [enableSmartPlanning, setEnableSmartPlanning] = useState(false)
  const [loading, setLoading] = useState(false)

  const availableModels = useMemo(
    () => [{ id: 'auto', name: 'Auto（智能路由）', capabilities: ['tool'] }, ...toolModels],
    [toolModels],
  )

  useEffect(() => {
    if (!availableModels.some(item => item.id === model)) setModel('auto')
  }, [availableModels, model])

  useEffect(() => {
    if (!open) return
    const preferredModel = selectedModel && selectedModel !== 'auto' ? selectedModel : 'auto'
    if (preferredModel === 'auto' || availableModels.some(item => item.id === preferredModel)) {
      setModel(preferredModel)
    }
  }, [availableModels, open, selectedModel])

  const reset = () => {
    setTitle('')
    setDescription('')
    setExecutionHint('')
    setModel(selectedModel && selectedModel !== 'auto' ? selectedModel : 'auto')
    setSpec('')
    setShowSpec(false)
    setEnableSmartPlanning(false)
  }

  const handleSubmit = async () => {
    const requirement = description.trim()
    if (!requirement) return
    setLoading(true)
    try {
      await onSubmit({
        title: title.trim() || requirement.slice(0, 40),
        description: requirement,
        projectType: 'unknown',
        techStack: executionHint.trim(),
        model: model === 'auto' ? undefined : model,
        spec: spec.trim() || undefined,
        enableSmartPlanning,
      })
      reset()
      onClose()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-[95vw] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-primary" />
            新建 AI 任务
          </DialogTitle>
          <DialogDescription>
            直接描述目标。AI 会判断任务类型、所需能力、产物、验证方式以及是否需要构建、审查或预览。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              任务描述 <span className="text-destructive">*</span>
            </label>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="描述要完成的工作、已有材料、目标产物和约束。例如：修改 Python 项目、生成 PPTX、处理 XLSX、创建文件或分析数据。"
              rows={5}
              className="resize-none text-sm"
            />
          </div>

          <div>
            <label className="mb-2 block text-[11px] font-medium uppercase text-muted-foreground">任务示例</label>
            <div className="grid gap-2 sm:grid-cols-2">
              {TASK_EXAMPLES.map(({ icon: Icon, label, prompt }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setDescription(prompt)}
                  className="flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-foreground">{label}</span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{prompt}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                任务标题 <span className="font-normal text-muted-foreground">（可选）</span>
              </label>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="不填则从描述生成"
                className="h-9"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">
                环境或工具提示 <span className="font-normal text-muted-foreground">（可选）</span>
              </label>
              <Input
                value={executionHint}
                onChange={(event) => setExecutionHint(event.target.value)}
                placeholder="例如 Python 3.12、LibreOffice、仅本地执行"
                className="h-9"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Cpu className="h-3.5 w-3.5 text-primary" />
              AI 模型
            </label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map(item => (
                  <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Auto 会根据任务和可用工具选择模型；项目或文件类型不再由这里预设。
            </p>
          </div>

          <div className="rounded-md border bg-muted/30 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <label htmlFor="smart-planning" className="flex items-center gap-1.5 text-sm font-medium">
                  <ListChecks className="h-3.5 w-3.5 text-primary" />
                  生成可审查计划
                </label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  开启后额外生成详细计划供查看。无论是否开启，任务都会先经过统一 AI 路由和能力解析。
                </p>
              </div>
              <Switch id="smart-planning" checked={enableSmartPlanning} onCheckedChange={setEnableSmartPlanning} />
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowSpec(value => !value)}
              className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-primary"
            >
              <FileText className="h-3.5 w-3.5 text-primary" />
              补充约束 <span className="text-xs font-normal text-muted-foreground">（可选）</span>
            </button>
            {showSpec && (
              <div className="space-y-2">
                <Textarea
                  value={spec}
                  onChange={(event) => setSpec(event.target.value)}
                  placeholder="填写安全边界、输出格式、质量标准、验证要求或不能修改的内容。"
                  rows={3}
                  className="resize-none text-sm"
                />
                <div className="flex flex-wrap gap-1.5">
                  {SPEC_EXAMPLES.map(example => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => setSpec(example)}
                      className="rounded-md border px-2 py-1 text-left text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>取消</Button>
          <Button onClick={handleSubmit} disabled={!description.trim() || loading} className="min-w-[120px] gap-2">
            {loading ? (
              <><Loader2 className="h-4 w-4 animate-spin" />提交中...</>
            ) : (
              <><Sparkles className="h-4 w-4" />开始执行</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
