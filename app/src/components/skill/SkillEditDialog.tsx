import { useState, useEffect, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { agentRegistryApi, type AgentRegistryDetail } from '@/lib/api'
import { 
  Folder, File, FileText, Code, FileJson, 
  Save, X, Loader2, ChevronRight, ChevronDown, MessageSquare, Eye, Send
} from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/toast'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'

interface SkillEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentId: string | null
}

interface FileNode {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  children?: FileNode[]
}

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface FileModification {
  action: string
  filePath: string
  reason: string
  newContent: string
}

export default function SkillEditDialog({ open, onOpenChange, agentId }: SkillEditDialogProps) {
  const [fileTree, setFileTree] = useState<FileNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  // 文件编辑状态
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [filePath, setFilePath] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  
  // 对话式编辑状态
  const [activeTab, setActiveTab] = useState<'direct' | 'conversation'>('direct')
  const [messages, setMessages] = useState<Message[]>([])
  const [inputMessage, setInputMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [modifications, setModifications] = useState<FileModification[]>([])
  const [showPreview, setShowPreview] = useState(false)
  const [originalContents, setOriginalContents] = useState<Record<string, string>>({})
  
  const { toast } = useToast()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 加载文件树
  useEffect(() => {
    if (open && agentId) {
      loadFileTree()
    }
    if (!open) {
      // 重置状态
      setFileTree([])
      setSelectedFile(null)
      setFileContent('')
      setFilePath('')
      setError(null)
      setMessages([])
      setModifications([])
      setShowPreview(false)
      setActiveTab('direct')
    }
  }, [open, agentId])

  // 滚动到最新消息
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  const loadFileTree = async () => {
    if (!agentId) return
    setLoading(true)
    setError(null)
    try {
      const tree = await agentRegistryApi.getFileTree(agentId)
      setFileTree(tree || [])
    } catch (e: any) {
      console.error('加载文件树失败:', e)
      setError('加载文件树失败: ' + (e.message || '未知错误'))
    } finally {
      setLoading(false)
    }
  }

  // 读取文件内容
  const readFile = async (path: string) => {
    if (!agentId) return
    try {
      const content = await agentRegistryApi.readFile(agentId, path)
      setFileContent(content || '')
      setFilePath(path)
      setSelectedFile(path)
    } catch (e: any) {
      console.error('读取文件失败:', e)
      toast({ title: '读取文件失败', description: e.message || '未知错误', variant: 'destructive' })
    }
  }

  // 保存文件
  const saveFile = async () => {
    if (!agentId || !filePath) return
    setSaving(true)
    try {
      await agentRegistryApi.updateFile(agentId, filePath, fileContent)
      toast({ title: '保存成功', description: `文件 ${filePath} 已更新` })
    } catch (e: any) {
      console.error('保存文件失败:', e)
      toast({ title: '保存失败', description: e.message || '未知错误', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  // 发送对话消息
  const sendMessage = async () => {
    if (!agentId || !inputMessage.trim()) return
    
    const userMessage = inputMessage.trim()
    setInputMessage('')
    setSending(true)
    
    // 添加用户消息到历史
    const newMessages = [...messages, { role: 'user' as const, content: userMessage }]
    setMessages(newMessages)
    
    try {
      // 调用对话式编辑API
      const response = await agentRegistryApi.processConversation(agentId, userMessage, newMessages.slice(0, -1))
      
      if (response && response.modifications) {
        // 添加助手回复
        setMessages([...newMessages, { 
          role: 'assistant' as const, 
          content: response.message || '我已理解您的需求，以下是建议的修改：' 
        }])
        
        // 保存修改建议和原始内容
        setModifications(response.modifications)
        setOriginalContents(response.originalContents || {})
        setShowPreview(true)
      } else {
        setMessages([...newMessages, { 
          role: 'assistant' as const, 
          content: '抱歉，我无法处理您的请求。请重新描述您的需求。' 
        }])
      }
    } catch (e: any) {
      console.error('处理对话消息失败:', e)
      setMessages([...newMessages, { 
        role: 'assistant' as const, 
        content: '处理请求时出现错误：' + (e.message || '未知错误') 
      }])
    } finally {
      setSending(false)
    }
  }

  // 应用修改
  const applyModifications = async () => {
    if (!agentId || modifications.length === 0) return
    
    try {
      await agentRegistryApi.applyModifications(agentId, modifications)
      toast({ title: '修改已应用', description: `已成功应用 ${modifications.length} 个文件修改` })
      setShowPreview(false)
      setModifications([])
      // 重新加载文件树
      await loadFileTree()
    } catch (e: any) {
      console.error('应用修改失败:', e)
      toast({ title: '应用修改失败', description: e.message || '未知错误', variant: 'destructive' })
    }
  }

  // 切换文件夹展开状态
  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  // 获取文件图标
  const getFileIcon = (name: string) => {
    if (name.endsWith('.md')) return <FileText className="w-4 h-4 text-blue-500" />
    if (name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.js') || name.endsWith('.jsx')) 
      return <Code className="w-4 h-4 text-yellow-500" />
    if (name.endsWith('.json')) return <FileJson className="w-4 h-4 text-green-500" />
    if (name.endsWith('.py')) return <Code className="w-4 h-4 text-blue-600" />
    return <File className="w-4 h-4 text-gray-500" />
  }

  // 渲染文件树
  const renderFileTree = (nodes: FileNode[], depth = 0): JSX.Element[] => {
    return nodes.map(node => (
      <div key={node.path}>
        <div 
          className={`flex items-center py-1 px-2 cursor-pointer hover:bg-muted/50 rounded ${
            selectedFile === node.path ? 'bg-muted' : ''
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => {
            if (node.isDirectory) {
              toggleDir(node.path)
            } else {
              readFile(node.path)
            }
          }}
        >
          {node.isDirectory ? (
            <>
              {expandedDirs.has(node.path) ? 
                <ChevronDown className="w-4 h-4 mr-1 text-muted-foreground" /> : 
                <ChevronRight className="w-4 h-4 mr-1 text-muted-foreground" />
              }
              <Folder className="w-4 h-4 mr-2 text-yellow-500" />
            </>
          ) : (
            <span className="w-4 h-4 mr-1" />
          )}
          {!node.isDirectory && getFileIcon(node.name)}
          <span className="ml-1 text-sm truncate">{node.name}</span>
        </div>
        {node.isDirectory && expandedDirs.has(node.path) && node.children && (
          <div>
            {renderFileTree(node.children, depth + 1)}
          </div>
        )}
      </div>
    ))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-7xl h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>技能文件编辑器 - {agentId}</DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'direct' | 'conversation')} className="flex-1 flex flex-col">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="direct">直接编辑</TabsTrigger>
            <TabsTrigger value="conversation">对话式编辑</TabsTrigger>
          </TabsList>

          {/* 直接编辑模式 */}
          <TabsContent value="direct" className="flex-1 flex flex-col">
            <div className="flex flex-1 overflow-hidden">
              {/* 文件树 */}
              <div className="w-64 border-r overflow-y-auto">
                <div className="p-2">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-medium">文件</h3>
                    <Button variant="ghost" size="sm" onClick={loadFileTree} disabled={loading}>
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : '刷新'}
                    </Button>
                  </div>
                  {loading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : error ? (
                    <div className="text-sm text-destructive p-2">{error}</div>
                  ) : fileTree.length === 0 ? (
                    <div className="text-sm text-muted-foreground p-2">暂无文件</div>
                  ) : (
                    renderFileTree(fileTree)
                  )}
                </div>
              </div>

              {/* 文件编辑区 */}
              <div className="flex-1 flex flex-col">
                {selectedFile ? (
                  <>
                    <div className="flex items-center justify-between p-2 border-b">
                      <div className="flex items-center">
                        {getFileIcon(selectedFile)}
                        <span className="ml-2 text-sm font-medium">{filePath}</span>
                      </div>
                      <Button onClick={saveFile} disabled={saving} size="sm">
                        {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                        保存
                      </Button>
                    </div>
                    <div className="flex-1 p-2">
                      <Textarea 
                        value={fileContent}
                        onChange={(e) => setFileContent(e.target.value)}
                        className="w-full h-full min-h-[500px] font-mono text-sm"
                        placeholder="文件内容..."
                      />
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <File className="w-12 h-12 mx-auto mb-4 opacity-20" />
                      <p>请从左侧选择要编辑的文件</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          {/* 对话式编辑模式 */}
          <TabsContent value="conversation" className="flex-1 flex flex-col">
            <div className="flex flex-1 overflow-hidden">
              {/* 对话区域 */}
              <div className="flex-1 flex flex-col border-r">
                <div className="flex-1 overflow-y-auto p-4">
                  {messages.length === 0 ? (
                    <div className="text-center text-muted-foreground mt-8">
                      <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-20" />
                      <p>开始对话式编辑</p>
                      <p className="text-sm mt-2">请用自然语言描述您想要做的修改</p>
                      <div className="mt-4 text-left max-w-md mx-auto">
                        <p className="text-sm font-medium mb-2">示例：</p>
                        <ul className="text-sm space-y-1">
                          <li>• "在SKILL.md中添加一个新功能说明"</li>
                          <li>• "修改scripts/main.py，添加错误处理"</li>
                          <li>• "创建一个新的配置文件config.json"</li>
                        </ul>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {messages.map((msg, idx) => (
                        <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[80%] p-3 rounded-lg ${
                            msg.role === 'user' 
                              ? 'bg-primary text-primary-foreground' 
                              : 'bg-muted'
                          }`}>
                            <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                          </div>
                        </div>
                      ))}
                      <div ref={messagesEndRef} />
                    </div>
                  )}
                </div>
                
                {/* 输入区域 */}
                <div className="p-4 border-t">
                  <div className="flex gap-2">
                    <Textarea 
                      value={inputMessage}
                      onChange={(e) => setInputMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          sendMessage()
                        }
                      }}
                      placeholder="描述您想要做的修改..."
                      className="flex-1 min-h-[60px] max-h-[120px]"
                      disabled={sending}
                    />
                    <Button onClick={sendMessage} disabled={sending || !inputMessage.trim()}>
                      {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
              </div>

              {/* 修改预览区域 */}
              {showPreview && modifications.length > 0 && (
                <div className="w-96 flex flex-col">
                  <div className="p-2 border-b flex items-center justify-between">
                    <h3 className="text-sm font-medium">修改预览</h3>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setShowPreview(false)}>
                        关闭
                      </Button>
                      <Button size="sm" onClick={applyModifications}>
                        应用修改
                      </Button>
                    </div>
                  </div>
                  <ScrollArea className="flex-1 p-2">
                    <div className="space-y-4">
                      {modifications.map((mod, idx) => (
                        <div key={idx} className="border rounded p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium">{mod.filePath}</span>
                            <span className={`text-xs px-2 py-1 rounded ${
                              mod.action === 'create' ? 'bg-green-100 text-green-700' :
                              mod.action === 'update' ? 'bg-blue-100 text-blue-700' :
                              'bg-red-100 text-red-700'
                            }`}>
                              {mod.action === 'create' ? '新建' :
                               mod.action === 'update' ? '更新' : '删除'}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mb-2">{mod.reason}</p>
                          {mod.action !== 'delete' && (
                            <div className="mt-2">
                              <p className="text-xs font-medium mb-1">新内容预览：</p>
                              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap">
                                {mod.newContent.substring(0, 500)}
                                {mod.newContent.length > 500 && '...'}
                              </pre>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
