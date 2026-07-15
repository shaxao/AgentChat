import { useState, useEffect } from 'react'
import {
  Plus, Search, Loader2, Sparkles, X, Check, Wand2, Bot,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { scenarioApi, agentRegistryApi, workflowApi, type AgentRegistryItem, type ScenarioDetail, type ScenarioCreateRequest, type WorkflowBriefVO, BASE_URL } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAuthStore, useChatStore } from '@/store'

// ==================== 常量 ====================

export const PROFESSION_OPTIONS = [
  '餐饮业', '开发者', '数据', '创作者', '管理', '教育',
]

export const ICON_OPTIONS = [
  '🍽️', '💻', '📊', '✍️', '📋', '🎓',
  '🏢', '💼', '📈', '🎨', '🔧', '🌐',
  '🤖', '💡', '📝', '🎯', '📚', '🔍',
]

export function guessIconFromText(name: string, description: string): string {
  const text = (name + ' ' + description).toLowerCase()
  if (text.match(/餐|饮|食|厨|菜/)) return '🍽️'
  if (text.match(/代码|编程|开发|程序|前端|后端|全栈|debug/)) return '💻'
  if (text.match(/数据|分析|报表|可视化|统计/)) return '📊'
  if (text.match(/写作|创作|文章|内容|博客|创意/)) return '✍️'
  if (text.match(/记录|笔记|文档|整理|计划/)) return '📋'
  if (text.match(/教育|学习|培训|课程|知识/)) return '🎓'
  if (text.match(/公司|企业|团队|组织|管理/)) return '🏢'
  if (text.match(/商业|业务|项目|工作|职业/)) return '💼'
  if (text.match(/增长|销售|营销|市场|趋势/)) return '📈'
  if (text.match(/设计|创意|艺术|绘画|视觉/)) return '🎨'
  if (text.match(/工具|修复|运维|系统|技术/)) return '🔧'
  if (text.match(/全球|国际|海外|外语|翻译/)) return '🌐'
  if (text.match(/ai|智能|机器|助手|自动/)) return '🤖'
  if (text.match(/创新|想法|思考|灵感|发现/)) return '💡'
  if (text.match(/文字|写|报告|总结/)) return '📝'
  if (text.match(/目标|达成|绩效|效率/)) return '🎯'
  if (text.match(/学|研究|阅读|书|知识库/)) return '📚'
  if (text.match(/搜索|查找|调研|检索/)) return '🔍'
  return '💡'
}

export function renderScenarioIcon(icon: string, imgClass?: string, textClass?: string) {
  if (!icon) return <span className={textClass}>💡</span>
  if (icon.startsWith('http')) {
    return <img src={icon} alt="icon" className={cn('rounded-lg object-cover', imgClass)} onError={(e) => {
      (e.target as HTMLImageElement).style.display = 'none'
    }} />
  }
  return <span className={textClass}>{icon}</span>
}

// ==================== AI 辅助函数 ====================

async function generateSystemPrompt(
  name: string,
  description: string,
  profession: string,
  token: string | null
): Promise<string> {
  const content = `请为以下场景生成一段专业的系统提示词（System Prompt），直接输出提示词内容，不要任何解释。

场景名称：${name}
职业领域：${profession}
场景描述：${description || '（未填写）'}

要求：
1. 提示词应明确 AI 的角色和职责
2. 包含具体的行为准则和输出格式要求
3. 语言专业、简洁，中文输出
4. 长度控制在 200-400 字`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const convResp = await fetch(`${BASE_URL}/chat/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ title: '场景提示词生成', model: 'auto' }),
  })
  if (!convResp.ok) throw new Error('创建对话失败')
  const conv = await convResp.json()
  const convId = conv.data?.id
  if (!convId) throw new Error('创建临时对话失败：响应格式异常')

  const res = await fetch(`${BASE_URL}/chat/conversations/${convId}/messages/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content, model: 'auto' }),
  })
  if (!res.ok || !res.body) throw new Error('请求失败: HTTP ' + res.status)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let rawText = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    rawText += decoder.decode(value, { stream: true })
  }

  let result = ''
  let currentEvent = ''
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('event:')) { currentEvent = trimmed.slice(6).trim().toLowerCase(); continue }
    if (trimmed.startsWith('data:')) {
      try {
        const d = JSON.parse(trimmed.slice(5).trim())
        if (currentEvent === 'token' && (d.token || d.content || d.message)) {
          result += (d.token || d.content || d.message || '')
        }
        if (currentEvent === 'done' && !result) {
          result += (d.token || d.content || d.message || '')
        }
      } catch {}
    }
  }

  // 清理临时对话
  try {
    const delRes = await fetch(`${BASE_URL}/chat/conversations/${convId}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (delRes.ok) useChatStore.getState().deleteConversation(convId)
  } catch { useChatStore.getState().deleteConversation(convId) }

  return result.trim()
}

async function recommendSkills(
  name: string,
  description: string,
  availableSkills: AgentRegistryItem[],
  token: string | null
): Promise<string[]> {
  if (availableSkills.length === 0) return []
  const skillList = availableSkills.map(s => `- ${s.agentId}: ${s.name}（${s.description || ''}）`).join('\n')
  const content = `根据以下场景信息，从可用技能列表中选出最适合的技能（最多3个），只返回 agentId 列表，用逗号分隔，不要其他内容。

场景：${name}
描述：${description || '（未填写）'}

可用技能列表：
${skillList}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'Accept': 'text/event-stream',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const convResp = await fetch(`${BASE_URL}/chat/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ title: '场景技能推荐', model: 'auto' }),
  })
  if (!convResp.ok) return []
  const conv = await convResp.json()
  const convId = conv.data?.id
  if (!convId) return []

  const res = await fetch(`${BASE_URL}/chat/conversations/${convId}/messages/stream`, {
    method: 'POST', headers, body: JSON.stringify({ content, model: 'auto' }),
  })
  if (!res.ok || !res.body) return []

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let rawText = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    rawText += decoder.decode(value, { stream: true })
  }

  let result = ''
  let currentEvent = ''
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('event:')) { currentEvent = trimmed.slice(6).trim().toLowerCase(); continue }
    if (trimmed.startsWith('data:')) {
      try {
        const d = JSON.parse(trimmed.slice(5).trim())
        if (currentEvent === 'token' && (d.token || d.content || d.message)) {
          result += (d.token || d.content || d.message || '')
        }
      } catch {}
    }
  }

  try {
    const delRes = await fetch(`${BASE_URL}/chat/conversations/${convId}`, {
      method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (delRes.ok) useChatStore.getState().deleteConversation(convId)
  } catch { useChatStore.getState().deleteConversation(convId) }

  const ids = result.trim().split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
  return ids.filter(id => availableSkills.some(s => s.agentId === id))
}

// ==================== 组件 Props ====================

export interface ScenarioFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 是否为管理员（控制官方开关可见性） */
  isAdmin?: boolean
  /** 编辑已有场景时传入场景 ID */
  editingId?: number | null
  /** 创建/编辑成功后回调 */
  onSuccess?: () => void
}

// ==================== 表单组件 ====================

export default function ScenarioFormDialog({
  open, onOpenChange, isAdmin = false, editingId: initialEditingId = null, onSuccess,
}: ScenarioFormDialogProps) {
  const [editingId, setEditingId] = useState<number | null>(initialEditingId)
  const [formData, setFormData] = useState<ScenarioCreateRequest>({
    name: '', icon: '💡', profession: '开发者', description: '',
    systemPrompt: '', recommendedSkills: [], isOfficial: false, isPublic: true,
  })
  const [formLoading, setFormLoading] = useState(false)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  // 技能选择
  const [availableSkills, setAvailableSkills] = useState<AgentRegistryItem[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [skillSearch, setSkillSearch] = useState('')
  const [availableWorkflows, setAvailableWorkflows] = useState<WorkflowBriefVO[]>([])
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<Set<number>>(new Set())

  // AI 生成状态
  const [genIconLoading, setGenIconLoading] = useState(false)
  const [genPromptLoading, setGenPromptLoading] = useState(false)
  const [genSkillsLoading, setGenSkillsLoading] = useState(false)

  const token = useAuthStore(s => s.token)

  const setFieldError = (field: string, msg: string) => setFormErrors(prev => ({ ...prev, [field]: msg }))
  const clearFieldErrors = () => setFormErrors({})

  const mapErrorToField = (errorMessage: string | null | undefined): { field: string; message: string } => {
    const msg = (errorMessage || '操作失败').trim()
    if (/场景名称|名称.*重复|名称.*已存在/.test(msg)) return { field: 'name', message: msg }
    if (/职业/.test(msg)) return { field: 'profession', message: msg }
    if (/提示词/.test(msg)) return { field: 'systemPrompt', message: msg }
    return { field: 'general', message: msg }
  }

  const loadAvailableSkills = async () => {
    setSkillsLoading(true)
    try {
      const result = await agentRegistryApi.list({ page: 1, size: 100 })
      const list: AgentRegistryItem[] = result.list || result.content || []
      setAvailableSkills(list.filter(s => s.status === 'active' || s.status === 'approved'))
    } catch (e) {
      console.error('[ScenarioFormDialog] 加载技能列表失败:', e)
    } finally {
      setSkillsLoading(false)
    }
  }

  const loadAvailableWorkflows = async () => {
    try {
      setAvailableWorkflows(await workflowApi.list())
    } catch (e) {
      console.error('[ScenarioFormDialog] 加载工作流列表失败:', e)
    }
  }

  // 初始化：打开时加载技能，如果是编辑模式则加载详情
  const initForm = async () => {
    clearFieldErrors()
    if (initialEditingId) {
      try {
        const detail = await scenarioApi.detail(initialEditingId)
        setEditingId(initialEditingId)
        setFormData({
          name: detail.name, icon: detail.icon, profession: detail.profession,
          description: detail.description || '', systemPrompt: detail.systemPrompt || '',
          recommendedSkills: detail.recommendedSkills || [],
          isOfficial: detail.isOfficial, isPublic: detail.isPublic,
        })
        setSelectedSkillIds(new Set(detail.recommendedSkills || []))
        setSelectedWorkflowIds(new Set((detail.workflowTemplates || []).map(w => w.id)))
      } catch (e) {
        console.error('[ScenarioFormDialog] 加载场景详情失败:', e)
      }
    } else {
      setEditingId(null)
      setFormData({
        name: '', icon: '💡', profession: '开发者', description: '',
        systemPrompt: '', recommendedSkills: [], isOfficial: false, isPublic: true,
      })
      setSelectedSkillIds(new Set())
      setSelectedWorkflowIds(new Set())
    }
    setSkillSearch('')
    loadAvailableSkills()
    loadAvailableWorkflows()
  }

  // 当 open 变为 true 时重新初始化表单（修复 Dialog.onOpenChange 不可靠的问题）
  useEffect(() => {
    if (open) initForm()
  }, [open, initialEditingId])

  const filteredSkills = availableSkills.filter(s => {
    if (!skillSearch) return true
    const q = skillSearch.toLowerCase()
    return s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)
  })

  // ─── 提交 ───
  const handleSubmit = async () => {
    clearFieldErrors()
    let hasError = false
    if (!formData.name.trim()) { setFieldError('name', '请输入场景名称'); hasError = true }
    if (!formData.profession) { setFieldError('profession', '请选择职业领域'); hasError = true }
    if (!formData.systemPrompt?.trim()) { setFieldError('systemPrompt', '请输入系统提示词'); hasError = true }
    if (hasError) return

    setFormLoading(true)
    try {
      const submitData = {
        ...formData,
        recommendedSkills: Array.from(selectedSkillIds),
        workflowIds: Array.from(selectedWorkflowIds),
      }
      if (editingId) {
        await scenarioApi.update(editingId, submitData)
      } else {
        const res = await scenarioApi.create(submitData)
        // 非管理员创建后自动激活场景
        if (!isAdmin) {
          useChatStore.getState().setActiveScenario({ id: res.id, name: res.name, icon: res.icon })
        }
      }
      onOpenChange(false)
      onSuccess?.()
    } catch (e: any) {
      const { field, message } = mapErrorToField(e.message)
      setFieldError(field, message)
    } finally {
      setFormLoading(false)
    }
  }

  // ─── AI 生成图标 ───
  const handleGenIcon = async () => {
    if (!formData.name.trim()) { setFieldError('name', '请先填写场景名称'); return }
    setGenIconLoading(true)
    clearFieldErrors()
    try {
      const prompt = `为"${formData.name}"场景生成一个简洁现代的app图标。职业领域：${formData.profession || '通用'}。描述：${formData.description || ''}。风格：扁平化设计，色彩鲜明，适合作为应用图标，正方形构图。`
      const res = await fetch(`${BASE_URL}/chat/generate-icon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ prompt, size: '1024x1024' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const url = data.data?.url || data.url
      if (url) {
        setFormData(f => ({ ...f, icon: url }))
      } else {
        throw new Error('返回数据无 url 字段')
      }
    } catch (e: any) {
      console.warn('[AI图标] 生成失败，降级为emoji:', e.message)
      const icon = guessIconFromText(formData.name || '', formData.description || '')
      setFormData(f => ({ ...f, icon }))
    } finally {
      setGenIconLoading(false)
    }
  }

  // ─── AI 生成提示词 ───
  const handleGenPrompt = async () => {
    if (!formData.name.trim()) { setFieldError('name', '请先填写场景名称'); return }
    setGenPromptLoading(true)
    clearFieldErrors()
    try {
      const prompt = await generateSystemPrompt(
        formData.name, formData.description || '', formData.profession || '通用', token,
      )
      if (prompt) {
        setFormData(f => ({ ...f, systemPrompt: prompt }))
      }
    } catch (e: any) {
      setFieldError('general', 'AI 生成失败: ' + (e.message || '请稍后重试'))
    } finally {
      setGenPromptLoading(false)
    }
  }

  // ─── AI 推荐技能 ───
  const handleGenSkills = async () => {
    if (!formData.name.trim()) { setFieldError('name', '请先填写场景名称'); return }
    if (availableSkills.length === 0) { setFieldError('general', '技能商店暂无可用技能'); return }
    setGenSkillsLoading(true)
    clearFieldErrors()
    try {
      const ids = await recommendSkills(formData.name, formData.description || '', availableSkills, token)
      if (ids.length > 0) {
        setSelectedSkillIds(new Set(ids))
      } else {
        setFieldError('general', 'AI 未能推荐出合适的技能，请手动选择')
      }
    } catch (e: any) {
      setFieldError('general', 'AI 推荐失败: ' + (e.message || '请稍后重试'))
    } finally {
      setGenSkillsLoading(false)
    }
  }

  // ─── Dialog open/close 回调 ───
  const handleOpenChange = (next: boolean) => {
    if (next) initForm()
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[95vw] max-w-[820px] max-h-[92vh] overflow-x-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{editingId ? '编辑场景' : '创建新场景'}</DialogTitle>
          <DialogDescription>
            {editingId ? '修改场景配置' : isAdmin ? '填写场景信息，创建后用户可在场景广场看到' : '发布个人场景到社区，与其他用户分享你的专属配置'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 flex-1 min-h-0 overflow-y-auto pr-1">
          {/* 场景名称 */}
          <div className="space-y-1.5">
            <Label className="text-xs">场景名称 *</Label>
            <Input
              placeholder="例如：餐饮经营管理"
              value={formData.name}
              onChange={e => setFormData(f => ({ ...f, name: e.target.value }))}
            />
            {formErrors.name && <p className="text-xs text-destructive">{formErrors.name}</p>}
          </div>

          {/* 图标 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-xs">图标</Label>
              <Button
                type="button" size="sm" variant="ghost"
                className="h-7 text-xs gap-1 text-primary hover:text-primary"
                onClick={handleGenIcon} disabled={genIconLoading}
              >
                {genIconLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                AI 生成图标
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ICON_OPTIONS.map(icon => (
                <button
                  key={icon} type="button"
                  onClick={() => setFormData(f => ({ ...f, icon }))}
                  className={cn(
                    'w-9 h-9 rounded-lg border-2 flex items-center justify-center text-lg transition-all flex-shrink-0',
                    formData.icon === icon
                      ? 'border-primary bg-primary/10 scale-110'
                      : 'border-transparent hover:border-muted-foreground/20'
                  )}
                >{icon}</button>
              ))}
            </div>
            {formData.icon && formData.icon.startsWith('http') && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
                {renderScenarioIcon(formData.icon, 'w-12 h-12', 'text-3xl')}
                <div>
                  <p className="text-[11px] text-primary font-medium">AI 生成图标</p>
                  <p className="text-[11px] text-muted-foreground">点击下方 emoji 可切换回表情图标</p>
                </div>
              </div>
            )}
          </div>

          {/* 职业 */}
          <div className="space-y-1.5">
            <Label className="text-xs">职业领域 *</Label>
            <div className="flex flex-wrap gap-2">
              {PROFESSION_OPTIONS.map(p => (
                <Badge
                  key={p}
                  variant={formData.profession === p ? 'default' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => setFormData(f => ({ ...f, profession: p }))}
                >{p}</Badge>
              ))}
            </div>
            {formErrors.profession && <p className="text-xs text-destructive">{formErrors.profession}</p>}
          </div>

          {/* 描述 */}
          <div className="space-y-1.5">
            <Label className="text-xs">场景描述</Label>
            <Textarea
              placeholder="简要描述这个场景的用途..."
              value={formData.description}
              onChange={e => setFormData(f => ({ ...f, description: e.target.value }))}
              rows={2}
            />
          </div>

          {/* 系统提示词 */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-xs">系统提示词 *</Label>
              <Button
                type="button" size="sm" variant="ghost"
                className="h-7 text-xs gap-1 text-primary hover:text-primary flex-shrink-0"
                onClick={handleGenPrompt} disabled={genPromptLoading || !formData.name.trim()}
              >
                {genPromptLoading ? <><Loader2 className="w-3 h-3 animate-spin" />生成中...</> : <><Wand2 className="w-3 h-3" />AI 生成</>}
              </Button>
            </div>
            <Textarea
              placeholder="输入场景激活时注入的系统提示词，或点击上方「AI 生成提示词」自动生成..."
              value={formData.systemPrompt}
              onChange={e => setFormData(f => ({ ...f, systemPrompt: e.target.value }))}
              rows={6} className="font-mono text-xs"
            />
            {formErrors.systemPrompt && <p className="text-xs text-destructive">{formErrors.systemPrompt}</p>}
            <p className="text-[11px] text-muted-foreground">用户激活此场景时，该提示词将作为 system prompt 注入对话</p>
          </div>

          {/* 推荐技能 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Label className="text-xs">推荐技能（选填）</Label>
                {selectedSkillIds.size > 0 && (
                  <span className="text-[11px] text-primary font-medium">已选 {selectedSkillIds.size} 个</span>
                )}
              </div>
              <Button
                type="button" size="sm" variant="ghost"
                className="h-7 text-xs gap-1 text-primary hover:text-primary flex-shrink-0"
                onClick={handleGenSkills}
                disabled={genSkillsLoading || !formData.name.trim() || availableSkills.length === 0}
              >
                {genSkillsLoading ? <><Loader2 className="w-3 h-3 animate-spin" />推荐中...</> : <><Bot className="w-3 h-3" />AI 推荐</>}
              </Button>
            </div>

            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索技能..." value={skillSearch}
                onChange={e => setSkillSearch(e.target.value)}
                className="pl-8 h-8 text-xs"
              />
            </div>

            <div className="border rounded-lg max-h-48 overflow-y-auto">
              {skillsLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-xs text-muted-foreground">加载技能商店...</span>
                </div>
              ) : filteredSkills.length === 0 ? (
                <div className="text-center py-6 text-xs text-muted-foreground">
                  {availableSkills.length === 0 ? '技能商店暂无上架技能' : '没有匹配的技能'}
                </div>
              ) : (
                <div className="divide-y">
                  {filteredSkills.map(skill => {
                    const selected = selectedSkillIds.has(skill.agentId)
                    return (
                      <button
                        key={skill.agentId} type="button"
                        onClick={() => {
                          setSelectedSkillIds(prev => {
                            const next = new Set(prev)
                            if (next.has(skill.agentId)) next.delete(skill.agentId)
                            else next.add(skill.agentId)
                            return next
                          })
                        }}
                        className={cn(
                          'w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors',
                          selected && 'bg-primary/5'
                        )}
                      >
                        <div className={cn(
                          'w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center transition-colors',
                          selected ? 'bg-primary border-primary' : 'border-muted-foreground/40'
                        )}>
                          {selected && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                        </div>
                        <span className="text-lg flex-shrink-0">{skill.icon || '🔧'}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium truncate">{skill.name}</span>
                          </div>
                          {skill.description && (
                            <p className="text-[11px] text-muted-foreground truncate mt-0.5">{skill.description}</p>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {selectedSkillIds.size > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {Array.from(selectedSkillIds).map(id => {
                  const skill = availableSkills.find(s => s.agentId === id)
                  return (
                    <Badge
                      key={id} variant="secondary"
                      className="gap-1 text-xs cursor-pointer hover:bg-destructive/20 group"
                      onClick={() => setSelectedSkillIds(prev => { const next = new Set(prev); next.delete(id); return next })}
                    >
                      {skill?.icon || '🔧'} {skill?.name || id}
                      <X className="w-3 h-3 opacity-50 group-hover:opacity-100" />
                    </Badge>
                  )
                })}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">用户激活场景时，勾选的技能将被自动安装</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label className="text-xs">关联工作流（选填）</Label>
              {selectedWorkflowIds.size > 0 && (
                <span className="text-[11px] text-primary font-medium">已选 {selectedWorkflowIds.size} 个</span>
              )}
            </div>
            <div className="border rounded-lg max-h-36 overflow-y-auto">
              {availableWorkflows.length === 0 ? (
                <div className="text-center py-5 text-xs text-muted-foreground">暂无可关联工作流</div>
              ) : (
                <div className="divide-y">
                  {availableWorkflows.map(workflow => {
                    const selected = selectedWorkflowIds.has(workflow.id)
                    return (
                      <button
                        key={workflow.id}
                        type="button"
                        onClick={() => setSelectedWorkflowIds(prev => {
                          const next = new Set(prev)
                          if (next.has(workflow.id)) next.delete(workflow.id)
                          else next.add(workflow.id)
                          return next
                        })}
                        className={cn('w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/40', selected && 'bg-primary/5')}
                      >
                        <div className={cn(
                          'w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center',
                          selected ? 'bg-primary border-primary' : 'border-muted-foreground/40'
                        )}>
                          {selected && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium truncate">{workflow.name}</div>
                          {workflow.description && <div className="text-[11px] text-muted-foreground truncate">{workflow.description}</div>}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">这里是场景模板的默认工作流；激活后的对话里仍可临时执行其它工作流，只影响当前对话。</p>
          </div>

          {/* 开关选项 */}
          <div className="flex flex-wrap items-center gap-4 sm:gap-6 pt-1">
            {isAdmin && (
              <div className="flex items-center gap-2">
                <Switch
                  checked={formData.isOfficial}
                  onCheckedChange={v => setFormData(f => ({ ...f, isOfficial: v }))}
                />
                <Label className="text-xs cursor-pointer">官方场景</Label>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Switch
                checked={formData.isPublic}
                onCheckedChange={v => setFormData(f => ({ ...f, isPublic: v }))}
              />
              <Label className="text-xs cursor-pointer">
                {isAdmin ? '公开（用户在场景广场可见）' : '发布到社区（用户可在场景广场找到）'}
              </Label>
            </div>
          </div>

          {formErrors.general && (
            <div className="bg-destructive/10 text-destructive text-sm rounded-lg p-3">{formErrors.general}</div>
          )}
        </div>

        <DialogFooter className="flex-shrink-0 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSubmit} disabled={formLoading}>
            {formLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {editingId ? '保存修改' : '创建场景'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
