import { useState, useRef, useEffect } from 'react'
import { Loader2, CheckCircle, Upload, FileText, FileArchive, Copy, ClipboardCheck, X, Plus, Sparkles, Wand2, Play, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription
} from '@/components/ui/dialog'
import { agentRegistryApi, BASE_URL, getToken, adminApi, toolCodeApi, type AgentRegistryDetail } from '@/lib/api'
import { cn } from '@/lib/utils'

interface AgentRegisterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  /** 编辑模式：传入已有技能详情 */
  editItem?: AgentRegistryDetail | null
}

type PublishMode = 'manual' | 'zip' | 'skillmd'

export default function AgentRegisterDialog({ open, onOpenChange, onSuccess, editItem }: AgentRegisterDialogProps) {
  const isEditing = !!editItem
  const [mode, setMode] = useState<PublishMode>('manual')

  // 手动填写 fields
  const [agentId, setAgentId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [categories, setCategories] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [author, setAuthor] = useState('')
  const [model, setModel] = useState('gpt-4o')
  const [tools, setTools] = useState('')

  // ── 优化3: 分类标签、模型列表、AI工具/图标 ──
  const [existingCategories, setExistingCategories] = useState<string[]>([])
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set())
  const [toolModels, setToolModels] = useState<{ id: string; name: string }[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [icon, setIcon] = useState('')
  const [genIconLoading, setGenIconLoading] = useState(false)
  // AI 工具生成
  const [toolDescriptions, setToolDescriptions] = useState<{ desc: string; code: string; name: string; testing: boolean; testResult: string }[]>([])
  const [genToolsLoading, setGenToolsLoading] = useState(false)

  // ZIP / SKILL.md upload
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  // 结果
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [resultAgentId, setResultAgentId] = useState('')
  const [resultSummary, setResultSummary] = useState('')
  const [copied, setCopied] = useState(false)

  // 编辑模式：预填充表单
  useEffect(() => {
    if (open && editItem) {
      setAgentId(editItem.agentId || '')
      setName(editItem.name || '')
      setDescription(editItem.description || '')
      setCategories((editItem.categories || []).join(', '))
      setSystemPrompt(editItem.systemPrompt || '')
      setAuthor(editItem.author || '')
      setModel(editItem.model || 'gpt-4o')
      setTools((editItem.tools || []).map(t => t.name).join(', '))
      setIcon(editItem.icon || '')
      setToolDescriptions((editItem.tools || []).map(t => ({
        desc: t.description || '', code: '', name: t.name, testing: false, testResult: ''
      })))
      setMode('manual')
      setError('')
      setDone(false)
      setResultAgentId('')
      setResultSummary('')
      setCopied(false)
    }
  }, [open, editItem])

  // 加载已有分类标签 + 带tool能力的模型
  useEffect(() => {
    if (open) {
      // 加载分类标签
      agentRegistryApi.getCategories().then(setExistingCategories).catch(() => {})
      // 加载带tool能力标签的渠道和模型
      setModelsLoading(true)
      Promise.all([
        adminApi.listChannels().catch(() => [] as any[]),
        adminApi.listModels().catch(() => [] as any[]),
      ]).then(([channels, allModels]) => {
        const activeChatModelIds = new Set<string>()
        ;(channels as any[]).filter((c: any) =>
          (c.status === 'active' || c.status === undefined) &&
          (!c.channelType || c.channelType === 'chat' || c.channel_type === 'chat')
        ).forEach((c: any) => {
          const channelModels = Array.isArray(c.models)
            ? c.models
            : typeof c.models === 'string'
              ? c.models.replace(/^\[/, '').replace(/\]$/, '').split(',').map((x: string) => x.replace(/["']/g, '').trim())
              : []
          channelModels.filter(Boolean).forEach((id: string) => activeChatModelIds.add(id))
        })
        // 筛选带 "tool" 标签的渠道
        const toolChannelIds = new Set(
          (channels as any[]).filter((c: any) => {
            const tags = c.tags
            if (!tags) return false
            if (Array.isArray(tags)) return tags.includes('tool')
            if (typeof tags === 'string') return tags.includes('tool')
            return false
          }).map((c: any) => c.id || c.uuid)
        )
        // 筛选属于tool渠道的模型
        const filtered = (allModels as any[]).filter((m: any) => {
          if (m.enabled === false) return false
          const modelId = m.modelId || m.model_id || m.model || m.id
          if (activeChatModelIds.size > 0 && !activeChatModelIds.has(modelId)) return false
          // 模型关联渠道ID匹配
          const modelChannelId = m.channelId || m.channel_id
          if (modelChannelId && toolChannelIds.has(modelChannelId)) return true
          // 或者模型自身带tool标签
          const mTags = m.tags
          if (Array.isArray(mTags) && mTags.includes('tool')) return true
          if (typeof mTags === 'string' && mTags.includes('tool')) return true
          return false
        }).map((m: any) => ({
          id: m.modelId || m.model_id || m.model || m.id,
          name: m.modelName || m.model_name || m.name || m.model || m.id,
        }))
        if (filtered.length > 0) {
          setToolModels(filtered)
          // 如果当前 model 不在列表中，且不是编辑模式，设为空
          if (!editItem && !filtered.find(f => f.id === model)) {
            setModel(filtered[0].id)
          }
        } else {
          // 兜底：没有带 tool 标签的渠道时，显示所有模型
          const allModelOptions = (allModels as any[]).filter((m: any) => m.enabled !== false).map((m: any) => ({
            id: m.modelId || m.model_id || m.model || m.id,
            name: m.modelName || m.model_name || m.name || m.model || m.id,
          }))
          const visibleModelOptions = activeChatModelIds.size > 0
            ? allModelOptions.filter(m => activeChatModelIds.has(m.id))
            : allModelOptions
          setToolModels(visibleModelOptions)
          if (!editItem && visibleModelOptions.length > 0 && !visibleModelOptions.find(f => f.id === model)) {
            setModel(visibleModelOptions[0].id)
          }
        }
      }).finally(() => setModelsLoading(false))
    }
  }, [open, editItem])

  // ── 手动提交 ──
  const handleManualSubmit = async () => {
    setError('')
    if (!agentId.trim()) { setError('Skill ID 不能为空'); return }
    if (!name.trim()) { setError('名称不能为空'); return }
    if (!systemPrompt.trim()) { setError('系统提示词不能为空'); return }
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) { setError('Skill ID 只允许字母、数字、短横线和下划线'); return }

    setLoading(true)
    try {
      // 合并分类标签：已选标签 + 自定义输入
      const allCategories = [...new Set([
        ...Array.from(selectedCategories),
        ...categories.split(',').map(c => c.trim()).filter(Boolean),
      ])]
      // 工具数据
      const toolsData = toolDescriptions
        .filter(t => t.name.trim())
        .map(t => ({ name: t.name.trim(), description: t.desc.trim(), code: t.code }))
      const payload = {
        agentId: agentId.trim(),
        name: name.trim(),
        description,
        categories: allCategories,
        systemPrompt,
        author: author || undefined,
        model,
        icon: icon || undefined,
        tools: toolsData.length > 0 ? toolsData.map(t => ({
          name: t.name,
          description: t.description,
          code: t.code || undefined,
          endpoint: t.code ? `script://scripts/${t.name}.py` : undefined,
        })) : undefined,
      }
      if (isEditing && editItem) {
        await agentRegistryApi.update(editItem.agentId, payload)
      } else {
        await agentRegistryApi.register(payload)
      }
      setResultAgentId(agentId.trim())
      setDone(true)
      setTimeout(() => onSuccess(), 2000)
    } catch (e: any) {
      setError(e?.message || (isEditing ? '更新失败' : '注册失败') + '，请重试')
    } finally {
      setLoading(false)
    }
  }

  // ── ZIP 批量上传提交 ──
  const handleZipSubmit = async () => {
    setError('')
    if (uploadFiles.length === 0) { setError('请选择 ZIP 文件'); return }
    setUploading(true)

    if (uploadFiles.length === 1) {
      // 单文件走 /api/skills/import
      try {
        const formData = new FormData()
        formData.append('file', uploadFiles[0])
        const token = getToken()
        const res = await fetch(`${BASE_URL}/skills/import`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        })
        const data = await res.json()
        if (data.code !== 200) throw new Error(data.message || '导入失败')
        setResultAgentId(data.data?.agentId || '')
        setResultSummary(`1 个技能导入成功: ${data.data?.name || data.data?.agentId}`)
        setDone(true)
        setTimeout(() => onSuccess(), 2000)
      } catch (e: any) {
        setError(e?.message || 'ZIP 导入失败')
      } finally { setUploading(false) }
    } else {
      // 多文件走 /api/skills/import-batch
      try {
        const formData = new FormData()
        uploadFiles.forEach(f => formData.append('files', f))
        const token = getToken()
        setUploadProgress(`正在批量导入 ${uploadFiles.length} 个技能...`)
        const res = await fetch(`${BASE_URL}/skills/import-batch`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        })
        const data = await res.json()
        if (data.code !== 200) throw new Error(data.message || '批量导入失败')
        const s = data.data
        setResultAgentId(s?.agentId || '')
        setResultSummary(`${s?.successCount || 0} 个成功, ${s?.failCount || 0} 个失败`)
        if (s?.details) setError(s.details) // 用 error 字段显示详情
        setDone(true)
        setTimeout(() => onSuccess(), 2000)
      } catch (e: any) {
        setError(e?.message || '批量导入失败')
      } finally { setUploading(false) }
    }
  }

  // ── SKILL.md 导入（仅用于手动预览编辑后提交） ──
  const generateIconForSkill = async (skillName: string, skillDescription?: string) => {
    if (!skillName.trim()) return ''
    setGenIconLoading(true)
    setError('')
    try {
      const prompt = `为技能「${skillName}」生成一个专业、简洁、现代的应用图标。技能描述：${skillDescription || '通用 AI 技能'}。要求：正方形构图、无文字、无表情符号、适合作为技能商店图标。`
      const token = getToken()
      const res = await fetch(`${BASE_URL}/chat/generate-icon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ prompt, size: '1024x1024' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return data.data?.url || data.url || ''
    } catch (e: any) {
      console.warn('[AI图标] 生成失败:', e.message)
      setError('AI 图标生成失败: ' + (e.message || '请稍后重试'))
      return ''
    } finally {
      setGenIconLoading(false)
    }
  }

  const handleSkillMdUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setUploadFiles([f])
    const reader = new FileReader()
    reader.onload = async () => {
      const text = reader.result as string
      setSystemPrompt(text)
      const titleMatch = text.match(/^#\s+(.+)/m)
      const nextName = titleMatch ? titleMatch[1].trim() : name
      // 尝试从 Markdown 提取名称和描述
      if (titleMatch) setName(nextName)
      const lines = text.split('\n').filter(l => l.trim())
      let desc = ''
      let afterTitle = false
      for (const l of lines) {
        if (!afterTitle && l.startsWith('#')) { afterTitle = true; continue }
        if (afterTitle && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('-') && l.trim().length > 3) {
          desc = l.trim().substring(0, 200)
          break
        }
        if (afterTitle && l.startsWith('## ')) { if (desc) break }
      }
      if (!desc) {
        for (const l of lines) {
          if (!l.startsWith('#') && l.trim().length > 3) { desc = l.trim().substring(0, 200); break }
        }
      }
      setDescription(desc)
      if (titleMatch) {
        const generated = nextName.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '-')
          .replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()
        setAgentId(generated || 'imported-skill')
      }
      if (nextName && !icon) {
        const generatedIcon = await generateIconForSkill(nextName, desc)
        if (generatedIcon) setIcon(generatedIcon)
      }
    }
    reader.readAsText(f)
  }

  // ── 生成自动安装指令 ──
  const installInstruction = resultAgentId
    ? `在穆果聊中安装技能「${name || resultAgentId}」：

方式一：打开技能商店，搜索「${name || resultAgentId}」并点击安装按钮

方式二：使用 API 安装
  POST ${BASE_URL}/api/v1/agent-registry/${resultAgentId}/install

方式三：下载技能包
  curl -sL "${BASE_URL}/skills/${resultAgentId}/download" \\
    -H "Authorization: Bearer YOUR_TOKEN" \\
    -o skill.zip`
    : ''

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(installInstruction)
    } catch {
      // 降级方案：使用 textarea 模拟复制
      const textarea = document.createElement('textarea')
      textarea.value = installInstruction
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(textarea)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // ── AI 生成图标 ──
  const handleGenIcon = async () => {
    if (!name.trim()) { setError('请先填写技能名称'); return }
    setGenIconLoading(true)
    setError('')
    try {
      const prompt = `为技能"${name}"生成一个简洁现代的app图标。技能描述：${description || '通用AI技能'}。风格：扁平化设计，色彩鲜明，适合作为技能商店图标，正方形构图。`
      const token = getToken()
      const res = await fetch(`${BASE_URL}/chat/generate-icon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ prompt, size: '1024x1024' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const url = data.data?.url || data.url
      if (url) {
        setIcon(url)
      } else {
        throw new Error('返回数据无 url 字段')
      }
    } catch (e: any) {
      console.warn('[AI图标] 生成失败:', e.message)
      setError('AI 图标生成失败: ' + (e.message || '请稍后重试'))
    } finally {
      setGenIconLoading(false)
    }
  }

  // ── AI 生成工具代码 ──
  const addToolField = () => {
    setToolDescriptions(prev => [...prev, { desc: '', code: '', name: '', testing: false, testResult: '' }])
  }

  const removeToolField = (index: number) => {
    setToolDescriptions(prev => prev.filter((_, i) => i !== index))
  }

  const handleGenTools = async () => {
    const validDescs = toolDescriptions.filter(t => t.desc.trim())
    if (validDescs.length === 0) { setError('请先添加工具描述'); return }
    setGenToolsLoading(true)
    setError('')
    try {
      // 逐个工具调用专用代码生成端点 /api/tools/generate-code
      // 该端点有专门的系统提示词（要求生成 main(args) 函数）和 maxTokens=2048
      for (let i = 0; i < toolDescriptions.length; i++) {
        const tool = toolDescriptions[i]
        if (!tool.desc.trim()) continue

        // 如果没有工具名，从描述生成一个 snake_case 名称
        let toolName = tool.name.trim()
        if (!toolName) {
          const words = tool.desc.trim()
            .split(/[\s,，。.]+/)
            .filter(w => /^[a-zA-Z]/.test(w))
          toolName = words.slice(0, 3).join('_').toLowerCase().replace(/[^a-zA-Z0-9_]/g, '') || `tool_${i + 1}`
        }

        await new Promise<void>((resolve, reject) => {
          toolCodeApi.generateCode(
            toolName,
            tool.desc,
            'python',
            (code) => {
              // onToken: 流式更新代码
              setToolDescriptions(prev => prev.map((t, idx) =>
                idx === i ? { ...t, code } : t
              ))
            },
            (code) => {
              // onDone: 代码生成完成
              setToolDescriptions(prev => prev.map((t, idx) =>
                idx === i ? { ...t, code, name: toolName } : t
              ))
              resolve()
            },
            (error) => {
              reject(new Error(error))
            }
          )
        })
      }
    } catch (e: any) {
      console.warn('[AI工具] 生成失败:', e.message)
      setError('AI 工具生成失败: ' + (e.message || '请稍后重试'))
    } finally {
      setGenToolsLoading(false)
    }
  }

  // 测试单个工具
  const handleTestTool = async (index: number) => {
    const tool = toolDescriptions[index]
    if (!tool.code) return
    setToolDescriptions(prev => prev.map((t, i) => i === index ? { ...t, testing: true, testResult: '' } : t))
    try {
      const token = getToken()
      const res = await fetch(`${BASE_URL}/v1/agent-registry/test-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ code: tool.code, name: tool.name }),
      })
      const data = await res.json()
      if (res.ok && data.code === 200) {
        setToolDescriptions(prev => prev.map((t, i) =>
          i === index ? { ...t, testing: false, testResult: data.data?.result || '测试通过' } : t
        ))
      } else {
        setToolDescriptions(prev => prev.map((t, i) =>
          i === index ? { ...t, testing: false, testResult: '测试失败: ' + (data.message || '未知错误') } : t
        ))
      }
    } catch (e: any) {
      setToolDescriptions(prev => prev.map((t, i) =>
        i === index ? { ...t, testing: false, testResult: '测试失败: ' + (e.message || '网络错误') } : t
      ))
    }
  }

  // ── 重置 ──
  const resetForm = () => {
    setAgentId(''); setName(''); setDescription(''); setCategories('')
    setSystemPrompt(''); setAuthor(''); setModel('gpt-4o'); setTools('')
    setIcon(''); setToolDescriptions([]); setSelectedCategories(new Set())
    setUploadFiles([]); setError(''); setDone(false)
    setResultAgentId(''); setCopied(false); setResultSummary(''); setUploadProgress('')
  }

  const tabStyle = (m: PublishMode) => cn(
    'flex-1 py-2.5 text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1.5',
    mode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'
  )

  return (
    <Dialog open={open} onOpenChange={val => { if (!val) resetForm(); onOpenChange(val) }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? '编辑技能' : '发布 Skill'}</DialogTitle>
          <DialogDescription>
            {isEditing ? '修改您的技能配置' : '创建并发布您的 Skill。支持手动填写、ZIP 打包上传或导入 SKILL.md 文件。'}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="flex flex-col items-center py-6 gap-4">
            <CheckCircle className="w-12 h-12 text-green-500" />
            <div className="text-center">
              <p className="font-semibold">{isEditing ? '保存成功！' : '发布成功！'}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {resultSummary || (mode === 'zip' ? '技能已导入并激活。' : '您的 Skill 已提交审核。')}
              </p>
              {error && mode === 'zip' && uploadFiles.length > 1 && (
                <pre className="text-[10px] text-left mt-2 p-2 bg-muted rounded whitespace-pre-wrap max-h-32 overflow-auto">{error}</pre>
              )}
            </div>
            {resultAgentId && (
              <div className="w-full space-y-3">
                <div className="bg-muted/50 rounded-lg p-3 text-left">
                  <p className="text-xs font-semibold mb-2">自动安装指令</p>
                  <pre className="text-[10px] whitespace-pre-wrap text-muted-foreground leading-relaxed overflow-auto max-h-40">
                    {installInstruction}
                  </pre>
                </div>
                <Button size="sm" variant="outline" className="w-full gap-1.5" onClick={handleCopy}>
                  {copied ? <ClipboardCheck className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? '已复制' : '复制安装指令'}
                </Button>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={() => { resetForm(); onOpenChange(false) }}>
              关闭
            </Button>
          </div>
        ) : (
          <>
            {/* 发布模式 Tab */}
            <div className="flex gap-1 bg-muted p-1 rounded-lg">
              <button className={tabStyle('manual')} onClick={() => setMode('manual')}>
                <FileText className="w-3.5 h-3.5" />手工填写
              </button>
              <button className={tabStyle('zip')} onClick={() => setMode('zip')}>
                <FileArchive className="w-3.5 h-3.5" />ZIP 上传
              </button>
              <button className={tabStyle('skillmd')} onClick={() => setMode('skillmd')}>
                <Upload className="w-3.5 h-3.5" />导入 SKILL.md
              </button>
            </div>

            {/* Manual mode */}
            {mode === 'manual' && (
              <div className="space-y-3 py-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Skill ID <span className="text-red-400">*</span></Label>
                    <Input placeholder="my-agent" value={agentId} onChange={e => setAgentId(e.target.value)} disabled={isEditing} />
                  </div>
                  <div>
                    <Label>名称 <span className="text-red-400">*</span></Label>
                    <Input placeholder="我的智能助手" value={name} onChange={e => setName(e.target.value)} />
                  </div>
                </div>
                <div>
                  <Label>描述</Label>
                  <Textarea placeholder="简要描述 Skill 的功能..." value={description}
                    onChange={e => setDescription(e.target.value)} rows={2} />
                </div>

                {/* 图标 */}
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <Label className="text-xs">技能图标</Label>
                    <Button
                      type="button" size="sm" variant="ghost"
                      className="h-7 text-xs gap-1 text-primary"
                      onClick={handleGenIcon} disabled={genIconLoading}
                    >
                      {genIconLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      AI 生成图标
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center text-xl shrink-0 overflow-hidden">
                      {icon ? (
                        (icon.startsWith('http') || icon.startsWith('/api/')) ? <img src={icon} alt="icon" className="w-full h-full object-cover" /> : <span>{icon}</span>
                      ) : <span className="text-muted-foreground">🤖</span>}
                    </div>
                    <Input placeholder="或输入 emoji 图标（如 🤖）" value={icon} onChange={e => setIcon(e.target.value)} className="text-sm" />
                  </div>
                </div>

                {/* 分类标签 */}
                <div>
                  <Label className="text-xs mb-1.5 block">分类标签</Label>
                  {existingCategories.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {existingCategories.map(cat => (
                        <Badge
                          key={cat}
                          variant={selectedCategories.has(cat) ? 'default' : 'outline'}
                          className="cursor-pointer text-xs"
                          onClick={() => {
                            setSelectedCategories(prev => {
                              const next = new Set(prev)
                              next.has(cat) ? next.delete(cat) : next.add(cat)
                              return next
                            })
                          }}
                        >{cat}</Badge>
                      ))}
                    </div>
                  )}
                  <Input placeholder="自定义标签（逗号分隔）" value={categories}
                    onChange={e => setCategories(e.target.value)} className="text-sm" />
                  <p className="text-[11px] text-muted-foreground mt-1">点击上方标签选择已有分类，或在输入框中自定义</p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>作者</Label>
                    <Input placeholder="您的名字" value={author} onChange={e => setAuthor(e.target.value)} />
                  </div>
                  <div>
                    <Label>推荐模型</Label>
                    {modelsLoading ? (
                      <div className="flex items-center gap-2 h-9 text-xs text-muted-foreground">
                        <Loader2 className="w-3 h-3 animate-spin" />加载中...
                      </div>
                    ) : (
                      <select className="w-full border rounded-md px-3 py-2 text-sm bg-background" value={model} onChange={e => setModel(e.target.value)}>
                        {toolModels.map(m => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                {/* AI 工具生成 */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">工具定义</Label>
                    <Button
                      type="button" size="sm" variant="ghost"
                      className="h-7 text-xs gap-1 text-primary"
                      onClick={handleGenTools}
                      disabled={genToolsLoading || toolDescriptions.filter(t => t.desc.trim()).length === 0}
                    >
                      {genToolsLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                      {genToolsLoading ? '生成中...' : 'AI 生成代码'}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={addToolField}>
                      <Plus className="w-3 h-3" />添加工具
                    </Button>
                  </div>
                  {toolDescriptions.map((tool, idx) => (
                    <div key={idx} className="border rounded-lg p-3 space-y-2 relative">
                      <button
                        className="absolute top-2 right-2 text-muted-foreground hover:text-destructive"
                        onClick={() => removeToolField(idx)}
                      ><X className="w-3.5 h-3.5" /></button>
                      <Input
                        placeholder={`工具 ${idx + 1} 名称（自动从代码提取）`}
                        value={tool.name}
                        onChange={e => {
                          setToolDescriptions(prev => prev.map((t, i) => i === idx ? { ...t, name: e.target.value } : t))
                        }}
                        className="text-sm h-8"
                        disabled={!!tool.code}
                      />
                      <Textarea
                        placeholder="用自然语言描述这个工具的功能，例如：查询指定城市的天气信息"
                        value={tool.desc}
                        onChange={e => {
                          setToolDescriptions(prev => prev.map((t, i) => i === idx ? { ...t, desc: e.target.value } : t))
                        }}
                        rows={2}
                        className="text-xs"
                      />
                      {tool.code && (
                        <>
                          <div className="bg-muted rounded p-2 overflow-auto max-h-32">
                            <pre className="text-[11px] font-mono whitespace-pre-wrap">{tool.code}</pre>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button" size="sm" variant="outline"
                              className="h-7 text-xs gap-1"
                              onClick={() => handleTestTool(idx)}
                              disabled={tool.testing}
                            >
                              {tool.testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                              测试
                            </Button>
                            {tool.testResult && (
                              <span className={cn(
                                'text-xs',
                                tool.testResult.includes('失败') ? 'text-destructive' : 'text-emerald-600'
                              )}>
                                {tool.testResult}
                              </span>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                  {toolDescriptions.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      点击「添加工具」然后用自然语言描述工具功能，AI 将自动生成 Python 代码
                    </p>
                  )}
                </div>

                <div>
                  <Label>系统提示词 <span className="text-red-400">*</span></Label>
                  <Textarea placeholder="你是一个专业的..." value={systemPrompt}
                    onChange={e => setSystemPrompt(e.target.value)} rows={4} />
                </div>
                {error && <p className="text-sm text-red-500">{error}</p>}
                <Button onClick={handleManualSubmit} disabled={loading} className="w-full">
                  {loading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                  {isEditing ? '保存修改' : '提交审核'}
                </Button>
              </div>
            )}

            {/* ZIP upload mode - 支持多文件批量上传 */}
            {mode === 'zip' && (
              <div className="space-y-4 py-4">
                <div
                  className={cn(
                    'border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors',
                    uploadFiles.length > 0 ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-primary/30'
                  )}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".zip"
                    multiple
                    className="hidden"
                    onChange={e => {
                      const files = Array.from(e.target.files || [])
                      if (files.length > 0) setUploadFiles(prev => [...prev, ...files])
                    }}
                  />
                  {uploadFiles.length > 0 ? (
                    <div className="flex flex-col items-center gap-2 w-full">
                      <FileArchive className="w-10 h-10 text-primary" />
                      <p className="text-sm font-medium">已选择 {uploadFiles.length} 个文件</p>
                      <div className="w-full max-h-32 overflow-auto">
                        {uploadFiles.map((f, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground justify-between py-0.5">
                            <span className="truncate max-w-[200px]">{f.name}</span>
                            <span className="shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
                            <button
                              className="text-red-400 hover:text-red-600 shrink-0"
                              onClick={e => { e.stopPropagation(); setUploadFiles(prev => prev.filter((_, j) => j !== i)) }}
                            ><X className="w-3 h-3" /></button>
                          </div>
                        ))}
                      </div>
                      <Button size="sm" variant="ghost" className="text-xs gap-1" onClick={e => { e.stopPropagation(); fileInputRef.current?.click() }}>
                        <Plus className="w-3 h-3" />继续添加文件
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      <Upload className="w-10 h-10 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        点击选择或拖拽技能 ZIP 文件
                      </p>
                      <p className="text-xs text-muted-foreground">
                        支持符合技能规范的 ZIP 包（含 SKILL.md + scripts/）。可多选批量导入。
                      </p>
                    </div>
                  )}
                </div>
                {uploadFiles.length > 0 && (
                  <div className="text-xs text-muted-foreground space-y-2">
                    <p>符合规范的技能 ZIP 必须包含：</p>
                    <ul className="list-disc pl-4 space-y-0.5">
                      <li><strong>SKILL.md</strong> — 技能入口文件（必填）</li>
                      <li><code className="bg-muted px-1 rounded text-[11px]">scripts/</code> — 工具脚本目录（可选）</li>
                      <li><code className="bg-muted px-1 rounded text-[11px]">package.json</code> — 元信息（可选）</li>
                    </ul>
                    <p>缺少 SKILL.md 的技能包将被拒绝导入。</p>
                    {uploadFiles.length > 1 && <p className="text-primary font-medium">多文件将批量导入到技能商店。</p>}
                  </div>
                )}
                {uploadProgress && (
                  <div className="flex items-center gap-2 text-sm text-primary">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {uploadProgress}
                  </div>
                )}
                {error && !done && <p className="text-sm text-red-500">{error}</p>}
                <Button onClick={handleZipSubmit} disabled={uploadFiles.length === 0 || uploading} className="w-full">
                  {uploading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Upload className="w-4 h-4 mr-1" />}
                  {uploading ? '导入中...' : uploadFiles.length > 1 ? `批量导入 ${uploadFiles.length} 个技能` : '上传并导入'}
                </Button>
              </div>
            )}

            {/* SKILL.md 导入模式 - 预览编辑后手动提交 */}
            {mode === 'skillmd' && (
              <div className="space-y-4 py-4">
                <div
                  className={cn(
                    'border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors',
                    uploadFiles.length > 0 ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-primary/30'
                  )}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".md,.markdown"
                    className="hidden"
                    onChange={handleSkillMdUpload}
                  />
                  {uploadFiles.length > 0 ? (
                    <div className="flex flex-col items-center gap-2">
                      <FileText className="w-10 h-10 text-primary" />
                      <p className="text-sm font-medium">{uploadFiles[0].name}</p>
                      <p className="text-xs text-muted-foreground">
                        已自动提取名称和描述。提示：推荐使用 ZIP 上传完整技能包。
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      <FileText className="w-10 h-10 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        点击选择 SKILL.md 文件
                      </p>
                      <p className="text-xs text-muted-foreground">
                        自动解析标题和描述，确认后提交。仅导入提示词，不含脚本/工具。
                      </p>
                    </div>
                  )}
                </div>
                {uploadFiles.length > 0 && (
                  <div className="space-y-3">
                    <div>
                      <Label>名称 <span className="text-red-400">*</span></Label>
                      <Input value={name} onChange={e => setName(e.target.value)} placeholder="自动解析..." />
                    </div>
                    <div>
                      <Label>Skill ID <span className="text-red-400">*</span></Label>
                      <Input value={agentId} onChange={e => setAgentId(e.target.value)} placeholder="自动生成..." />
                    </div>
                    <div>
                      <Label>描述</Label>
                      <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} />
                    </div>
                    <div>
                      <Label>分类标签（逗号分隔）</Label>
                      <Input value={categories} onChange={e => setCategories(e.target.value)} placeholder="办公,AI" />
                    </div>
                    <div>
                      <Label>作者</Label>
                      <Input value={author} onChange={e => setAuthor(e.target.value)} />
                    </div>
                    <div>
                      <Label>推荐模型</Label>
                      {modelsLoading ? (
                        <div className="flex items-center gap-2 h-9 text-xs text-muted-foreground">
                          <Loader2 className="w-3 h-3 animate-spin" />加载中...
                        </div>
                      ) : (
                        <select className="w-full border rounded-md px-3 py-2 text-sm bg-background" value={model} onChange={e => setModel(e.target.value)}>
                          {toolModels.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                      )}
                    </div>
                    <div>
                      <Label>系统提示词（已从 SKILL.md 导入）<span className="text-red-400">*</span></Label>
                      <Textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} rows={5}
                        className="text-xs font-mono" />
                    </div>
                  </div>
                )}
                {error && !done && <p className="text-sm text-red-500">{error}</p>}
                <Button onClick={handleManualSubmit} disabled={uploadFiles.length === 0 || loading} className="w-full">
                  {loading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                  {isEditing ? '保存修改' : '提交审核'}
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
