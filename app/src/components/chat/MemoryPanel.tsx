import { useState, useEffect, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Textarea } from '@/components/ui/textarea'
import { memoryApi, MemoryFileTreeNode, MemoryDocumentVO, MemoryWorkFileVO } from '@/lib/api'
import { useChatStore } from '@/store'
import {
  X, FolderOpen, File, Image, FileText, Table2, Puzzle, FileArchive,
  Search, Plus, Trash2, Save, Edit3, Eye, Upload, Brain, Folder,
  ChevronRight, ChevronDown, MoreHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ==================== 类型定义 ====================

interface MemoryPanelProps {
  onClose: () => void
}

type PanelTab = 'work_files' | 'memory' | 'profile'

// ==================== 文件图标映射 ====================

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  image: Image,
  document: FileText,
  spreadsheet: Table2,
  skill: Puzzle,
  audio: FileArchive,
  video: FileArchive,
  other: File,
  folder: Folder,
  project: FolderOpen,
  soul: Brain,
  tools: Puzzle,
  rules: FileText,
}

const TYPE_LABELS: Record<string, string> = {
  image: '图片',
  document: '文件',
  spreadsheet: '表格',
  skill: '技能',
  audio: '音频',
  video: '视频',
  other: '其他',
  soul: 'SOUL',
  tools: 'TOOLS',
  rules: 'RULES',
}

// ==================== 文件树节点组件 ====================

function TreeNode({
  node,
  depth = 0,
  selectedKey,
  onSelect,
  expandedKeys,
  onToggle,
}: {
  node: MemoryFileTreeNode
  depth: number
  selectedKey: string | null
  onSelect: (key: string, node: MemoryFileTreeNode) => void
  expandedKeys: Set<string>
  onToggle: (key: string) => void
}) {
  const isFolder = node.type === 'folder'
  const isExpanded = expandedKeys.has(node.key)
  const isSelected = selectedKey === node.key
  const IconComp = TYPE_ICONS[node.icon || 'file'] || File

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-1.5 cursor-pointer rounded-md text-sm transition-colors',
          'hover:bg-accent',
          isSelected && 'bg-primary/10 text-primary font-medium',
        )}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => {
          if (isFolder) {
            onToggle(node.key)
          } else {
            onSelect(node.key, node)
          }
        }}
      >
        {isFolder ? (
          isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <IconComp className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="truncate flex-1 min-w-0">{node.title}</span>
        {node.layer && !isFolder && (
          <Badge
            variant="outline"
            className={cn(
              'text-[10px] px-1 py-0 h-4 shrink-0 border-0',
              node.layer === 'L1' && 'bg-red-500/15 text-red-500',
              node.layer === 'L2' && 'bg-amber-500/15 text-amber-500',
              node.layer === 'L3' && 'bg-sky-500/15 text-sky-500',
              node.layer === 'L4' && 'bg-slate-500/15 text-slate-400',
            )}
          >
            {node.layer}
          </Badge>
        )}
        {node.fileType && TYPE_LABELS[node.fileType] && (
          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 shrink-0">
            {TYPE_LABELS[node.fileType]}
          </Badge>
        )}
      </div>
      {isFolder && isExpanded && node.children?.map(child => (
        <TreeNode
          key={child.key}
          node={child}
          depth={depth + 1}
          selectedKey={selectedKey}
          onSelect={onSelect}
          expandedKeys={expandedKeys}
          onToggle={onToggle}
        />
      ))}
    </div>
  )
}

// ==================== 文件内容查看/编辑器 ====================

function FileContentViewer({
  title,
  content,
  docType,
  fileType,
  ossUrl,
  docUuid,
  isOpen,
  onClose,
  onSave,
}: {
  title: string
  content: string
  docType?: string
  fileType?: string
  ossUrl?: string
  docUuid?: string
  isOpen: boolean
  onClose: () => void
  onSave?: (uuid: string, content: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState(content)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setEditContent(content)
    setEditing(false)
  }, [content, isOpen])

  const isImage = fileType === 'image' || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(title)
  const isMarkdown = title.endsWith('.md') || docType === 'project_memory' || docType === 'skill_memory' || docType === 'user_profile'

  const handleSave = async () => {
    if (!docUuid || !onSave) return
    setSaving(true)
    try {
      await onSave(docUuid, editContent)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="flex flex-row items-center justify-between px-4 py-3 border-b shrink-0">
          <DialogTitle className="text-sm font-medium truncate max-w-[400px]">{title}</DialogTitle>
          <div className="flex items-center gap-1">
            {onSave && docUuid && (editing ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setEditContent(content) }}>
                  取消
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  <Save className="w-3.5 h-3.5 mr-1" />
                  {saving ? '保存中...' : '保存'}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <Edit3 className="w-3.5 h-3.5 mr-1" />编辑
              </Button>
            ))}
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {isImage && ossUrl ? (
            <div className="flex items-center justify-center">
              <img src={ossUrl} alt={title} className="max-w-full max-h-[60vh] rounded-lg object-contain" />
            </div>
          ) : editing ? (
            <Textarea
              className="min-h-[400px] font-mono text-sm resize-none"
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
            />
          ) : (
            <pre className="whitespace-pre-wrap text-sm font-mono bg-muted/50 rounded-lg p-4 overflow-x-auto max-h-[60vh]">
              {content || '(空内容)'}
            </pre>
          )}
        </div>

        {ossUrl && !isImage && (
          <div className="px-4 py-2 border-t text-xs text-muted-foreground shrink-0">
            存储位置：{ossUrl}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ==================== 主面板组件 ====================

export default function MemoryPanel({ onClose }: MemoryPanelProps) {
  const activeConversationId = useChatStore(s => s.activeConversationId)

  const [activeTab, setActiveTab] = useState<PanelTab>('work_files')
  const [fileTree, setFileTree] = useState<MemoryFileTreeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set(['work_files', 'memory']))
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  // 文件内容查看
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerTitle, setViewerTitle] = useState('')
  const [viewerContent, setViewerContent] = useState('')
  const [viewerDocType, setViewerDocType] = useState('')
  const [viewerFileType, setViewerFileType] = useState('')
  const [viewerOssUrl, setViewerOssUrl] = useState('')
  const [viewerDocUuid, setViewerDocUuid] = useState('')
  const [profileContent, setProfileContent] = useState('')
  const [userPromptContent, setUserPromptContent] = useState('')
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)

  // 加载文件树
  const loadFileTree = useCallback(async () => {
    setLoading(true)
    try {
      const convUuid = activeConversationId || undefined
      const tree = await memoryApi.getFileTree(convUuid)
      setFileTree(tree || [])
    } catch (e) {
      console.error('[MemoryPanel] 加载文件树失败:', e)
    } finally {
      setLoading(false)
    }
  }, [activeConversationId])

  useEffect(() => { loadFileTree() }, [loadFileTree])

  const loadUserProfile = useCallback(async () => {
    setProfileLoading(true)
    try {
      const [profile, prompt] = await Promise.all([
        memoryApi.getUserProfile(),
        memoryApi.getUserSystemPrompt(),
      ])
      setProfileContent(profile.content || '')
      setUserPromptContent(prompt.content || '')
    } catch (e) {
      console.error('[MemoryPanel] 加载用户画像失败:', e)
    } finally {
      setProfileLoading(false)
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'profile') loadUserProfile()
  }, [activeTab, loadUserProfile])

  const handleSaveUserProfile = async () => {
    setProfileSaving(true)
    try {
      await Promise.all([
        memoryApi.saveUserProfile(profileContent),
        memoryApi.saveUserSystemPrompt(userPromptContent),
      ])
      await loadFileTree()
    } finally {
      setProfileSaving(false)
    }
  }

  const handleForgetUserProfile = async () => {
    if (!confirm('确定清除长期用户画像和用户系统提示词吗？此操作只影响你的画像数据。')) return
    setProfileSaving(true)
    try {
      await memoryApi.forgetUserProfile()
      await loadUserProfile()
      await loadFileTree()
    } finally {
      setProfileSaving(false)
    }
  }

  // 切换展开
  const handleToggle = (key: string) => {
    setExpandedKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 选择文件
  const handleSelect = async (key: string, node: MemoryFileTreeNode) => {
    setSelectedKey(key)

    // 工作文件节点：根据 key 前缀判断类型
    if (key.startsWith('wf_')) {
      const fileId = key.replace('wf_', '')
      try {
        const files = await memoryApi.listWorkFiles({})
        const file = files.find((f: MemoryWorkFileVO) => String(f.id) === fileId)
        if (file) {
          setViewerTitle(file.fileName)
          setViewerContent(file.description || '')
          setViewerFileType(file.fileType)
          setViewerOssUrl(file.ossUrl || '')
          setViewerDocUuid(file.docUuid || '')
          setViewerDocType('work_file_meta')
          setViewerOpen(true)
        }
      } catch { /* ignore */ }
    }
    // 记忆文档节点：docId 是 uuid
    else if (node.docId) {
      try {
        const doc = await memoryApi.getDocument(node.docId)
        setViewerTitle(doc.title)
        setViewerContent(doc.content || '')
        setViewerDocType(doc.docType)
        setViewerFileType(doc.fileType || '')
        setViewerOssUrl(doc.ossUrl || '')
        setViewerDocUuid(doc.uuid)
        setViewerOpen(true)
      } catch { /* ignore */ }
    }
  }

  // 保存文档
  const handleSaveDocument = async (uuid: string, content: string) => {
    await memoryApi.updateDocument(uuid, { content })
    await loadFileTree()
  }

  // 删除文档
  const handleDeleteDocument = async (uuid: string) => {
    if (!confirm('确定要删除此文档吗？')) return
    try {
      await memoryApi.deleteDocument(uuid)
      await loadFileTree()
    } catch { /* ignore */ }
  }

  // 搜索过滤
  const filterTree = (nodes: MemoryFileTreeNode[], query: string): MemoryFileTreeNode[] => {
    if (!query.trim()) return nodes
    const q = query.toLowerCase()
    return nodes.reduce<MemoryFileTreeNode[]>((acc, node) => {
      const titleMatch = node.title.toLowerCase().includes(q)
      if (node.type === 'folder' && node.children) {
        const filteredChildren = filterTree(node.children, q)
        if (filteredChildren.length > 0 || titleMatch) {
          acc.push({ ...node, children: filteredChildren })
        }
      } else if (titleMatch) {
        acc.push(node)
      }
      return acc
    }, [])
  }

  const filteredTree = filterTree(fileTree, searchQuery)

  // 创建新记忆文档
  const handleCreateDocument = async () => {
    const title = prompt('请输入文档标题：')
    if (!title) return
    const docType = prompt('文档类型（project_memory / skill_memory / conversation_summary）：', 'project_memory')
    if (!docType) return
    try {
      await memoryApi.saveDocument({
        docType,
        title,
        content: `# ${title}\n\n`,
        category: 'project',
      })
      await loadFileTree()
    } catch { /* ignore */ }
  }

  return (
    <>
      <div className="w-72 border-l bg-background flex flex-col h-full shrink-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b shrink-0">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold">项目文件</span>
          </div>
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleCreateDocument}>
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>新建记忆</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={loadFileTree}>
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-2.2-5.9M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </Button>
              </TooltipTrigger>
              <TooltipContent>刷新</TooltipContent>
            </Tooltip>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}>
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-3 pt-2.5 shrink-0">
          <Tabs value={activeTab} onValueChange={v => setActiveTab(v as PanelTab)} className="w-full">
            <TabsList className="w-full h-8">
              <TabsTrigger value="work_files" className="flex-1 text-xs h-7">工作文件</TabsTrigger>
              <TabsTrigger value="memory" className="flex-1 text-xs h-7">记忆</TabsTrigger>
              <TabsTrigger value="profile" className="flex-1 text-xs h-7">画像</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Search */}
        {activeTab !== 'profile' && <div className="px-3 py-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              className="h-7 pl-7 text-xs"
              placeholder="搜索文件..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        </div>}

        {/* Tree */}
        <div className="flex-1 overflow-y-auto px-1 py-1">
          {activeTab === 'profile' ? (
            <div className="space-y-3 px-2 pb-3">
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                  <Brain className="h-4 w-4 text-primary" />
                  用户画像 USER.md
                </div>
                <p className="text-[11px] leading-4 text-muted-foreground">
                  基于长期对话持续更新，可手动修正；系统会按身份、行为、偏好、认知、决策、价值取向六层融合。
                </p>
              </div>
              <div className="rounded-md border bg-background p-3 text-[11px] leading-4 text-muted-foreground">
                <p className="font-medium text-foreground">画像策略</p>
                <p className="mt-1">冷启动时只做轻量探索；偏好变化会优先尊重当前对话；一次性需求进入临时标签，重复或确认后才沉淀为稳定偏好。画像归用户所有，可编辑或清除。</p>
              </div>
              {profileLoading ? (
                <div className="py-8 text-center text-xs text-muted-foreground">加载中...</div>
              ) : (
                <>
                  <label className="block text-xs font-medium">长期用户画像</label>
                  <Textarea
                    className="min-h-[220px] resize-none font-mono text-xs"
                    value={profileContent}
                    onChange={e => setProfileContent(e.target.value)}
                  />
                  <label className="block text-xs font-medium">用户系统提示词</label>
                  <Textarea
                    className="min-h-[160px] resize-none font-mono text-xs"
                    value={userPromptContent}
                    onChange={e => setUserPromptContent(e.target.value)}
                  />
                  <Button className="w-full gap-1.5" size="sm" onClick={handleSaveUserProfile} disabled={profileSaving}>
                    <Save className="h-3.5 w-3.5" />
                    {profileSaving ? '保存中...' : '保存画像与提示词'}
                  </Button>
                  <Button className="w-full gap-1.5" size="sm" variant="outline" onClick={handleForgetUserProfile} disabled={profileSaving}>
                    <Trash2 className="h-3.5 w-3.5" />
                    清除画像与提示词
                  </Button>
                </>
              )}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              加载中...
            </div>
          ) : filteredTree.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <Folder className="w-8 h-8 text-muted-foreground/40 mb-2" />
              <p className="text-xs text-muted-foreground mb-1">暂无文件</p>
              <p className="text-[11px] text-muted-foreground/60">
                对话中产生的文件将出现在这里
              </p>
            </div>
          ) : (
            filteredTree.map(node => (
              <TreeNode
                key={node.key}
                node={node}
                depth={0}
                selectedKey={selectedKey}
                onSelect={handleSelect}
                expandedKeys={expandedKeys}
                onToggle={handleToggle}
              />
            ))
          )}
        </div>

        {/* Footer */}
        {activeConversationId && (
          <div className="px-3 py-2 border-t text-[11px] text-muted-foreground shrink-0">
            当前项目：<span className="font-mono text-primary/70">{activeConversationId.slice(0, 8)}...</span>
          </div>
        )}
      </div>

      {/* 文件内容查看器 */}
      <FileContentViewer
        title={viewerTitle}
        content={viewerContent}
        docType={viewerDocType}
        fileType={viewerFileType}
        ossUrl={viewerOssUrl}
        docUuid={viewerDocUuid}
        isOpen={viewerOpen}
        onClose={() => setViewerOpen(false)}
        onSave={handleSaveDocument}
      />
    </>
  )
}
