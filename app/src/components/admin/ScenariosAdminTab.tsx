import { useState, useEffect, useCallback } from 'react'
import {
  Plus, Search, Loader2, Sparkles, LayoutGrid,
  Edit, Trash2, CheckCircle2, Star, TrendingUp,
  ArrowLeft, RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import ScenarioFormDialog, { renderScenarioIcon } from '@/components/scenario/ScenarioFormDialog'
import { scenarioApi, type ScenarioBrief } from '@/lib/api'
import { isDemoMode } from '@/lib/api'

export default function ScenariosAdminTab() {
  const [scenarios, setScenarios] = useState<ScenarioBrief[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [pageError, setPageError] = useState<string | null>(null)

  // 创建/编辑弹窗（复用共享组件）
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)

  // 删除确认弹窗
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  const fetchScenarios = useCallback(async () => {
    setLoading(true)
    setPageError(null)
    try {
      const data = await scenarioApi.listAll()
      setScenarios(Array.isArray(data) ? data : [])
    } catch (e: any) {
      console.warn('获取场景列表失败:', e)
      setPageError(e.message || '获取场景列表失败')
      if (isDemoMode()) {
        setScenarios(getDemoScenarios())
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchScenarios() }, [fetchScenarios])

  // 过滤场景
  const filteredScenarios = scenarios.filter(s => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      s.name.toLowerCase().includes(q) ||
      s.profession.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    )
  })

  // ─── 表单操作 ───────────────────────────────────────
  const openCreateForm = () => {
    setEditingId(null)
    setFormOpen(true)
  }

  const openEditForm = async (id: number) => {
    setEditingId(id)
    setFormOpen(true)
  }

  const handleFormSuccess = () => {
    setFormOpen(false)
    fetchScenarios()
  }

  // ─── 删除操作 ───────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteId) return
    setDeleteLoading(true)
    try {
      await scenarioApi.delete(deleteId)
      setDeleteId(null)
      fetchScenarios()
    } catch (e: any) {
      alert('删除失败: ' + (e.message || e))
    } finally {
      setDeleteLoading(false)
    }
  }

  // ─── 切换状态 ────────────────────────────────────────
  const toggleOfficial = async (scenario: ScenarioBrief) => {
    try {
      await scenarioApi.update(scenario.id, { isOfficial: !scenario.isOfficial })
      fetchScenarios()
    } catch (e: any) {
      alert('操作失败: ' + (e.message || e))
    }
  }

  const togglePublic = async (scenario: ScenarioBrief) => {
    try {
      await scenarioApi.update(scenario.id, { isPublic: !scenario.isPublic })
      fetchScenarios()
    } catch (e: any) {
      alert('操作失败: ' + (e.message || e))
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* 顶部标题 + 操作 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">场景管理</h2>
          <p className="text-sm text-muted-foreground">{scenarios.length} 个场景（公开 {scenarios.filter(s => s.isPublic).length} / 官方 {scenarios.filter(s => s.isOfficial).length}）</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={fetchScenarios}>
            <RefreshCw className="w-4 h-4" />刷新
          </Button>
          <Button size="sm" className="gap-1.5" onClick={openCreateForm}>
            <Plus className="w-4 h-4" />创建场景
          </Button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="搜索场景名称、职业领域或描述..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* 错误提示 */}
      {pageError && (
        <div className="bg-destructive/10 text-destructive rounded-lg p-4 mb-6 flex items-center justify-between">
          <span className="text-sm">{pageError}</span>
          <Button size="sm" variant="outline" onClick={fetchScenarios}>重试</Button>
        </div>
      )}

      {/* 加载状态 */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* 场景表格 */}
      {!loading && (
        <div className="bg-card rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">场景</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">职业</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">使用次数</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredScenarios.map((scenario) => (
                <tr key={scenario.id} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {renderScenarioIcon(scenario.icon, 'w-8 h-8', 'text-2xl')}
                      <div>
                        <p className="font-medium text-sm">{scenario.name}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-[250px]">
                          {scenario.description}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="text-xs">{scenario.profession}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground">官方</span>
                        <Switch
                          checked={scenario.isOfficial}
                          onCheckedChange={() => toggleOfficial(scenario)}
                          className="scale-75"
                        />
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground">公开</span>
                        <Switch
                          checked={scenario.isPublic}
                          onCheckedChange={() => togglePublic(scenario)}
                          className="scale-75"
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {scenario.usageCount || 0}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0"
                        onClick={() => openEditForm(scenario.id)}
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                        onClick={() => setDeleteId(scenario.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {filteredScenarios.length === 0 && !loading && (
            <div className="text-center py-12 text-muted-foreground">
              <LayoutGrid className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">
                {searchQuery ? '没有匹配的场景' : '暂无场景，点击「创建场景」添加'}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ─── 创建/编辑弹窗（复用共享组件） ────────────── */}
      <ScenarioFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        isAdmin={true}
        editingId={editingId}
        onSuccess={handleFormSuccess}
      />

      {/* ─── 删除确认弹窗 ────────────────────────────── */}
      <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除这个场景吗？此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>取消</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteLoading}>
              {deleteLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Demo 模式使用示例数据
function getDemoScenarios(): ScenarioBrief[] {
  return [
    { id: 1, name: '餐饮经营管理', icon: '🍽️', profession: '餐饮业', description: '餐厅日常经营管理的全能助手', isOfficial: true, isPublic: true, usageCount: 128 },
    { id: 2, name: '全栈项目开发', icon: '💻', profession: '开发者', description: '从需求到部署的全流程开发助手', isOfficial: true, isPublic: true, usageCount: 256 },
    { id: 3, name: '数据洞察分析', icon: '📊', profession: '数据', description: '数据分析与可视化专家', isOfficial: true, isPublic: true, usageCount: 89 },
  ]
}
