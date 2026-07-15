import { useState, useEffect, useCallback } from 'react'
import {
  Plus, Search, Loader2, Shield, Key, Users,
  Edit, Trash2, RefreshCw, ChevronRight, ChevronDown,
  X, Check, AlertCircle,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { rbacApi, adminApi, type SysRoleVO, type SysPermissionVO } from '@/lib/api'
import { isDemoMode } from '@/lib/api'

type SubTab = 'roles' | 'permissions' | 'user-roles'

const PERMISSION_NAME_FALLBACK: Record<string, string> = {
  harness: 'Harness 演进',
  'harness:view': '查看 Harness 演进',
  'harness:patch': '管理 Harness 候选改进',
  'harness:regression': '管理 Harness 回归样本',
}

function permissionDisplayName(perm?: Pick<SysPermissionVO, 'permissionName' | 'permissionCode'> | null) {
  if (!perm) return ''
  return PERMISSION_NAME_FALLBACK[perm.permissionCode] || perm.permissionName
}

// ==================== 主组件 ====================
export default function RbacAdminTab() {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('roles')

  const subTabs: { id: SubTab; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
    { id: 'roles', icon: Shield, label: '角色管理' },
    { id: 'permissions', icon: Key, label: '权限管理' },
    { id: 'user-roles', icon: Users, label: '用户-角色分配' },
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 子 Tab 导航 */}
      <div className="border-b px-6 py-3 shrink-0">
        <div className="flex items-center gap-1">
          {subTabs.map(({ id, icon: Icon, label }) => (
            <Button
              key={id}
              variant={activeSubTab === id ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setActiveSubTab(id)}
              className="gap-1.5"
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* 子 Tab 内容 */}
      <div className="flex-1 overflow-y-auto">
        {activeSubTab === 'roles' && <RolesSubTab />}
        {activeSubTab === 'permissions' && <PermissionsSubTab />}
        {activeSubTab === 'user-roles' && <UserRolesSubTab />}
      </div>
    </div>
  )
}

// ==================== 角色管理 ====================
function RolesSubTab() {
  const [roles, setRoles] = useState<SysRoleVO[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  // 表单弹窗
  const [formOpen, setFormOpen] = useState(false)
  const [editingRole, setEditingRole] = useState<SysRoleVO | null>(null)
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<SysRoleVO | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  // 权限分配弹窗
  const [permDialogOpen, setPermDialogOpen] = useState(false)
  const [permRole, setPermRole] = useState<SysRoleVO | null>(null)

  const fetchRoles = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await rbacApi.listRoles()
      setRoles(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message || '获取角色列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchRoles() }, [fetchRoles])

  const filteredRoles = roles.filter(r => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return r.roleName.toLowerCase().includes(q) || r.roleCode.toLowerCase().includes(q)
  })

  // ─── 表单操作 ────────────────────────
  const openCreateForm = () => {
    setEditingRole(null)
    setFormOpen(true)
    setFormError(null)
  }

  const openEditForm = (role: SysRoleVO) => {
    setEditingRole(role)
    setFormOpen(true)
    setFormError(null)
  }

  const handleFormSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setFormLoading(true)
    setFormError(null)
    const form = e.currentTarget
    const data = {
      roleName: (form.elements.namedItem('roleName') as HTMLInputElement).value.trim(),
      roleCode: (form.elements.namedItem('roleCode') as HTMLInputElement).value.trim(),
      description: (form.elements.namedItem('description') as HTMLTextAreaElement).value.trim(),
      status: (form.elements.namedItem('status') as HTMLSelectElement).value,
      sortOrder: parseInt((form.elements.namedItem('sortOrder') as HTMLInputElement).value) || 0,
    }
    if (!data.roleName || !data.roleCode) {
      setFormError('角色名和角色代码不能为空')
      setFormLoading(false)
      return
    }
    try {
      if (editingRole) {
        await rbacApi.updateRole(editingRole.uuid, data)
      } else {
        await rbacApi.createRole(data)
      }
      setFormOpen(false)
      fetchRoles()
    } catch (e: any) {
      setFormError(e.message || '保存失败')
    } finally {
      setFormLoading(false)
    }
  }

  // ─── 删除操作 ────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleteLoading(true)
    try {
      await rbacApi.deleteRole(deleteTarget.uuid)
      setDeleteTarget(null)
      fetchRoles()
    } catch (e: any) {
      alert(e.message || '删除失败')
    } finally {
      setDeleteLoading(false)
    }
  }

  // ─── 渲染 ────────────────────────
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">角色列表</h3>
          <p className="text-sm text-muted-foreground">管理系统角色及其权限分配</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="icon" variant="ghost" onClick={fetchRoles} disabled={loading}>
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </Button>
          <Button size="sm" onClick={openCreateForm} disabled={isDemoMode()}>
            <Plus className="w-3.5 h-3.5 mr-1" />新建角色
          </Button>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="搜索角色..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">角色名</th>
                <th className="text-left px-4 py-2.5 font-medium">角色代码</th>
                <th className="text-left px-4 py-2.5 font-medium">描述</th>
                <th className="text-left px-4 py-2.5 font-medium">状态</th>
                <th className="text-left px-4 py-2.5 font-medium">排序</th>
                <th className="text-right px-4 py-2.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredRoles.map(role => (
                <tr key={role.id} className="border-t hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 font-medium">{role.roleName}</td>
                  <td className="px-4 py-2.5">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{role.roleCode}</code>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground max-w-[200px] truncate">{role.description || '-'}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={role.status === 'active' ? 'default' : 'secondary'} className="text-xs">
                      {role.status === 'active' ? '启用' : '禁用'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{role.sortOrder}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm" variant="ghost" className="h-7"
                        onClick={() => { setPermRole(role); setPermDialogOpen(true) }}
                      >
                        <Key className="w-3 h-3 mr-1" />权限
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7" onClick={() => openEditForm(role)}
                        disabled={role.isSystem === 1}>
                        <Edit className="w-3 h-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(role)}
                        disabled={role.isSystem === 1}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredRoles.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {searchQuery ? '无匹配角色' : '暂无角色，点击右上角新建'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 创建/编辑角色弹窗 */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingRole ? '编辑角色' : '新建角色'}</DialogTitle>
            <DialogDescription>
              {editingRole ? '修改角色信息' : '创建一个新的系统角色'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleFormSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="roleName">角色名称 *</Label>
              <Input id="roleName" name="roleName" defaultValue={editingRole?.roleName} placeholder="如：管理员" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roleCode">角色代码 *</Label>
              <Input id="roleCode" name="roleCode" defaultValue={editingRole?.roleCode} placeholder="如：admin" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">描述</Label>
              <Textarea id="description" name="description" defaultValue={editingRole?.description || ''} placeholder="角色描述..." rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="status">状态</Label>
                <Select name="status" defaultValue={editingRole?.status || 'active'}>
                  <SelectTrigger id="status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">启用</SelectItem>
                    <SelectItem value="disabled">禁用</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sortOrder">排序权重</Label>
                <Input id="sortOrder" name="sortOrder" type="number" defaultValue={editingRole?.sortOrder || 0} />
              </div>
            </div>
            {formError && (
              <div className="p-2 rounded bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />{formError}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>取消</Button>
              <Button type="submit" disabled={formLoading}>
                {formLoading && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                {editingRole ? '保存' : '创建'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除角色「{deleteTarget?.roleName}」吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteLoading}>
              {deleteLoading && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 权限分配弹窗 */}
      {permRole && (
        <PermissionAssignDialog
          open={permDialogOpen}
          onOpenChange={setPermDialogOpen}
          role={permRole}
          onSuccess={fetchRoles}
        />
      )}
    </div>
  )
}

// ==================== 权限分配弹窗 ====================
function PermissionAssignDialog({
  open, onOpenChange, role, onSuccess,
}: {
  open: boolean; onOpenChange: (open: boolean) => void; role: SysRoleVO; onSuccess: () => void;
}) {
  const [allPermissions, setAllPermissions] = useState<SysPermissionVO[]>([])
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    Promise.all([
      rbacApi.getPermissionTree(),
      rbacApi.getRolePermissionIds(role.id),
    ]).then(([perms, ids]) => {
      setAllPermissions(Array.isArray(perms) ? perms : [])
      setCheckedIds(new Set(Array.isArray(ids) ? ids : []))
    }).catch(e => setError(e.message || '加载权限失败'))
      .finally(() => setLoading(false))
  }, [open, role.id])

  const toggleAll = (checked: boolean) => {
    if (checked) {
      const allIds = new Set<number>()
      const collect = (perms: SysPermissionVO[]) => {
        perms.forEach(p => { allIds.add(p.id); if (p.children) collect(p.children) })
      }
      collect(allPermissions)
      setCheckedIds(allIds)
    } else {
      setCheckedIds(new Set())
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await rbacApi.assignPermissionsToRole(role.id, Array.from(checkedIds))
      onOpenChange(false)
      onSuccess()
    } catch (e: any) {
      setError(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const allSelected = (() => {
    const allIds = new Set<number>()
    const collect = (perms: SysPermissionVO[]) => {
      perms.forEach(p => { allIds.add(p.id); if (p.children) collect(p.children) })
    }
    collect(allPermissions)
    return allIds.size > 0 && Array.from(allIds).every(id => checkedIds.has(id))
  })()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>分配权限 - {role.roleName}</DialogTitle>
          <DialogDescription>选择该角色拥有的权限</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 pb-2 border-b mb-2">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={e => toggleAll(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm font-medium">全选</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1">
              {allPermissions.map(perm => (
                <PermTreeNode
                  key={perm.id}
                  perm={perm}
                  checkedIds={checkedIds}
                  onToggle={id => setCheckedIds(prev => {
                    const next = new Set(prev)
                    if (next.has(id)) next.delete(id); else next.add(id)
                    return next
                  })}
                />
              ))}
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSave} disabled={saving || loading}>
            {saving && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
            保存权限
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ==================== 权限树节点 ====================
function PermTreeNode({
  perm, checkedIds, onToggle, depth = 0,
}: {
  perm: SysPermissionVO; checkedIds: Set<number>; onToggle: (id: number) => void; depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = perm.children && perm.children.length > 0

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 transition-colors cursor-pointer text-sm',
        )}
        style={{ paddingLeft: `${12 + depth * 20}px` }}
      >
        {hasChildren ? (
          <button onClick={() => setExpanded(!expanded)} className="shrink-0">
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <input
          type="checkbox"
          checked={checkedIds.has(perm.id)}
          onChange={() => onToggle(perm.id)}
          className="rounded shrink-0"
        />
        <span className="flex-1 truncate">{permissionDisplayName(perm)}</span>
        <code className="text-[10px] text-muted-foreground bg-muted px-1 rounded shrink-0">{perm.permissionCode}</code>
        {perm.resourceType && (
          <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">{perm.resourceType}</Badge>
        )}
      </div>
      {hasChildren && expanded && (
        <div>
          {perm.children!.map(child => (
            <PermTreeNode key={child.id} perm={child} checkedIds={checkedIds} onToggle={onToggle} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

// ==================== 权限管理 ====================
function PermissionsSubTab() {
  const [permissions, setPermissions] = useState<SysPermissionVO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 表单弹窗
  const [formOpen, setFormOpen] = useState(false)
  const [editingPerm, setEditingPerm] = useState<SysPermissionVO | null>(null)
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<SysPermissionVO | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  // 创建时的父级选择（仅树视图用）
  const [flatPermissions, setFlatPermissions] = useState<SysPermissionVO[]>([])

  // 角色筛选
  const [roleList, setRoleList] = useState<SysRoleVO[]>([])
  const [selectedRoleId, setSelectedRoleId] = useState<string>('all')
  const [rolePermissionIds, setRolePermissionIds] = useState<Set<number>>(new Set())
  const [rolePermsLoading, setRolePermsLoading] = useState(false)

  const fetchPermissions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [tree, flat, roles] = await Promise.all([
        rbacApi.getPermissionTree(),
        rbacApi.listPermissionsFlat(),
        rbacApi.listRoles().catch(() => [] as SysRoleVO[]),
      ])
      setPermissions(Array.isArray(tree) ? tree : [])
      setFlatPermissions(Array.isArray(flat) ? flat : [])
      setRoleList(Array.isArray(roles) ? roles : [])
    } catch (e: any) {
      setError(e.message || '获取权限列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchPermissions() }, [fetchPermissions])

  // 角色切换 → 加载该角色的权限
  const handleRoleChange = async (roleId: string) => {
    setSelectedRoleId(roleId)
    if (roleId === 'all') {
      setRolePermissionIds(new Set())
      return
    }
    setRolePermsLoading(true)
    try {
      const ids = await rbacApi.getRolePermissionIds(parseInt(roleId))
      setRolePermissionIds(new Set(Array.isArray(ids) ? ids : []))
    } catch {
      setRolePermissionIds(new Set())
    } finally {
      setRolePermsLoading(false)
    }
  }

  const openCreateForm = () => {
    setEditingPerm(null)
    setFormOpen(true)
    setFormError(null)
  }

  const openEditForm = (perm: SysPermissionVO) => {
    setEditingPerm(perm)
    setFormOpen(true)
    setFormError(null)
  }

  const handleFormSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setFormLoading(true)
    setFormError(null)
    const form = e.currentTarget
    const parentStr = (form.elements.namedItem('parentId') as HTMLSelectElement).value
    const data = {
      permissionName: (form.elements.namedItem('permissionName') as HTMLInputElement).value.trim(),
      permissionCode: (form.elements.namedItem('permissionCode') as HTMLInputElement).value.trim(),
      parentId: parentStr !== 'root' ? parseInt(parentStr) : null,
      resourceType: (form.elements.namedItem('resourceType') as HTMLSelectElement).value,
      action: (form.elements.namedItem('action') as HTMLInputElement).value.trim() || undefined as any,
      description: (form.elements.namedItem('description') as HTMLTextAreaElement).value.trim(),
      sortOrder: parseInt((form.elements.namedItem('sortOrder') as HTMLInputElement).value) || 0,
    }
    if (!data.permissionName || !data.permissionCode) {
      setFormError('权限名称和代码不能为空')
      setFormLoading(false)
      return
    }
    try {
      if (editingPerm) {
        await rbacApi.updatePermission(editingPerm.uuid, data)
      } else {
        await rbacApi.createPermission(data)
      }
      setFormOpen(false)
      fetchPermissions()
    } catch (e: any) {
      setFormError(e.message || '保存失败')
    } finally {
      setFormLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleteLoading(true)
    try {
      await rbacApi.deletePermission(deleteTarget.uuid)
      setDeleteTarget(null)
      fetchPermissions()
    } catch (e: any) {
      alert(e.message || '删除失败')
    } finally {
      setDeleteLoading(false)
    }
  }

  // 统计权限数量
  const countPerms = (perms: SysPermissionVO[]): number =>
    perms.reduce((sum, p) => sum + 1 + (p.children ? countPerms(p.children) : 0), 0)

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">权限列表</h3>
          <p className="text-sm text-muted-foreground">
            共 {countPerms(permissions)} 个权限节点
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="icon" variant="ghost" onClick={fetchPermissions} disabled={loading}>
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </Button>
          <Button size="sm" onClick={openCreateForm} disabled={isDemoMode()}>
            <Plus className="w-3.5 h-3.5 mr-1" />新建权限
          </Button>
        </div>
      </div>

      {/* 角色筛选 */}
      <div className="flex items-center gap-3">
        <Label className="text-sm shrink-0">按角色筛选：</Label>
        <Select value={selectedRoleId} onValueChange={handleRoleChange}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="选择角色查看其权限..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部权限</SelectItem>
            {roleList.map(role => (
              <SelectItem key={role.id} value={role.id.toString()}>
                {role.roleName} ({role.roleCode})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {rolePermsLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        {selectedRoleId !== 'all' && !rolePermsLoading && (
          <span className="text-xs text-muted-foreground">
            已分配 {rolePermissionIds.size} 个权限
          </span>
        )}
        {selectedRoleId !== 'all' && (
          <Button variant="ghost" size="sm" className="h-7 text-xs"
            onClick={() => handleRoleChange('all')}>
            <X className="w-3 h-3 mr-1" />清除
          </Button>
        )}
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="rounded-lg border">
          <div className="p-3 border-b bg-muted/30 text-sm font-medium flex items-center gap-2">
            权限树
            {selectedRoleId !== 'all' && (
              <Badge variant="secondary" className="text-xs">
                {roleList.find(r => r.id.toString() === selectedRoleId)?.roleName || '未知角色'}
              </Badge>
            )}
          </div>
          <div className="p-3 space-y-0.5">
            {permissions.map(perm => (
              <PermTreeRow key={perm.id} perm={perm} depth={0}
                onEdit={openEditForm} onDelete={setDeleteTarget}
                rolePermissionIds={selectedRoleId !== 'all' ? rolePermissionIds : undefined} />
            ))}
          </div>
        </div>
      )}

      {/* 创建/编辑权限弹窗 */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingPerm ? '编辑权限' : '新建权限'}</DialogTitle>
            <DialogDescription>
              {editingPerm ? '修改权限信息' : '创建一个新的权限节点'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleFormSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="permissionName">权限名称 *</Label>
              <Input id="permissionName" name="permissionName" defaultValue={permissionDisplayName(editingPerm)} placeholder="如：技能发布" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="permissionCode">权限代码 *</Label>
              <Input id="permissionCode" name="permissionCode" defaultValue={editingPerm?.permissionCode} placeholder="如：skill:publish" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="parentId">上级权限</Label>
              <Select name="parentId" defaultValue={editingPerm?.parentId ? editingPerm.parentId.toString() : 'root'}>
                <SelectTrigger id="parentId"><SelectValue placeholder="无（顶级）" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="root">无（顶级）</SelectItem>
                  {flatPermissions.filter(p => p.id !== editingPerm?.id).map(p => (
                    <SelectItem key={p.id} value={p.id.toString()}>{permissionDisplayName(p)} ({p.permissionCode})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="resourceType">资源类型</Label>
                <Select name="resourceType" defaultValue={editingPerm?.resourceType || 'api'}>
                  <SelectTrigger id="resourceType"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="menu">菜单 (menu)</SelectItem>
                    <SelectItem value="button">按钮 (button)</SelectItem>
                    <SelectItem value="api">接口 (api)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="action">操作类型</Label>
                <Input id="action" name="action" defaultValue={editingPerm?.action || ''} placeholder="如：create/read/update/delete" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">描述</Label>
              <Textarea id="description" name="description" defaultValue={editingPerm?.description || ''} placeholder="权限描述..." rows={2} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sortOrder">排序权重</Label>
              <Input id="sortOrder" name="sortOrder" type="number" defaultValue={editingPerm?.sortOrder || 0} />
            </div>
            {formError && (
              <div className="p-2 rounded bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />{formError}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>取消</Button>
              <Button type="submit" disabled={formLoading}>
                {formLoading && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                {editingPerm ? '保存' : '创建'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              确定要删除权限「{permissionDisplayName(deleteTarget)}」吗？其子权限也会一并删除，此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteLoading}>
              {deleteLoading && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== 权限树行 ====================
function PermTreeRow({
  perm, depth, onEdit, onDelete, rolePermissionIds,
}: {
  perm: SysPermissionVO; depth: number; onEdit: (p: SysPermissionVO) => void; onDelete: (p: SysPermissionVO) => void;
  rolePermissionIds?: Set<number>;
}) {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = perm.children && perm.children.length > 0

  // 当前权限是否被选中角色持有
  const isAssigned = rolePermissionIds?.has(perm.id)

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 transition-colors text-sm group',
          isAssigned && 'bg-primary/5 border border-primary/20',
        )}
        style={{ paddingLeft: `${8 + depth * 20}px` }}
      >
        {hasChildren ? (
          <button onClick={() => setExpanded(!expanded)} className="shrink-0">
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {rolePermissionIds && (
          isAssigned
            ? <Check className="w-3.5 h-3.5 text-primary shrink-0" />
            : <span className="w-3.5 shrink-0 text-muted-foreground/30">-</span>
        )}
        <span className={cn('flex-1 font-medium truncate', isAssigned && 'text-primary')}>{permissionDisplayName(perm)}</span>
        <code className="text-[10px] text-muted-foreground bg-muted px-1 rounded shrink-0">{perm.permissionCode}</code>
        <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">{perm.resourceType}</Badge>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button size="sm" variant="ghost" className="h-6 w-6" onClick={() => onEdit(perm)}>
            <Edit className="w-3 h-3" />
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 text-destructive hover:text-destructive"
            onClick={() => onDelete(perm)}>
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </div>
      {hasChildren && expanded && (
        <div>
          {perm.children!.map(child => (
            <PermTreeRow key={child.id} perm={child} depth={depth + 1}
              onEdit={onEdit} onDelete={onDelete} rolePermissionIds={rolePermissionIds} />
          ))}
        </div>
      )}
    </div>
  )
}

// ==================== 用户-角色分配 ====================
function UserRolesSubTab() {
  const [users, setUsers] = useState<Array<{ id: string; name: string; email: string; role: string; status: string }>>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  // 角色分配弹窗
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignUser, setAssignUser] = useState<{ id: string; name: string } | null>(null)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await adminApi.listUsers({ page: 1, size: 200 })
      const list = Array.isArray(result)
        ? result
        : ((result as any)?.list || (result as any)?.records || [])
      setUsers(list.map((u: any) => ({
        id: String(u.id),
        name: u.name || u.username || '',
        email: u.email || '',
        role: u.role || '',
        status: u.status || 'active',
      })))
    } catch (e: any) {
      setError(e.message || '获取用户列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  const filteredUsers = users.filter(u => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  })

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">用户角色分配</h3>
          <p className="text-sm text-muted-foreground">为用户分配系统角色</p>
        </div>
        <Button size="icon" variant="ghost" onClick={fetchUsers} disabled={loading}>
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="搜索用户..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="pl-9" />
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">用户</th>
                <th className="text-left px-4 py-2.5 font-medium">邮箱</th>
                <th className="text-left px-4 py-2.5 font-medium">当前角色</th>
                <th className="text-left px-4 py-2.5 font-medium">状态</th>
                <th className="text-right px-4 py-2.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map(user => (
                <tr key={user.id} className="border-t hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 font-medium">{user.name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{user.email}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant="outline" className="text-xs">{user.role || 'user'}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={user.status === 'active' ? 'default' : 'secondary'} className="text-xs">
                      {user.status === 'active' ? '正常' : '禁用'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button size="sm" variant="outline" className="h-7"
                      onClick={() => { setAssignUser({ id: user.id, name: user.name }); setAssignOpen(true) }}>
                      <Shield className="w-3 h-3 mr-1" />分配角色
                    </Button>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    {searchQuery ? '无匹配用户' : '暂无用户'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* 角色分配弹窗 */}
      {assignUser && (
        <UserRoleAssignDialog
          open={assignOpen}
          onOpenChange={setAssignOpen}
          userId={assignUser.id}
          userName={assignUser.name}
          onSuccess={fetchUsers}
        />
      )}
    </div>
  )
}

// ==================== 用户-角色分配弹窗 ====================
function UserRoleAssignDialog({
  open, onOpenChange, userId, userName, onSuccess,
}: {
  open: boolean; onOpenChange: (open: boolean) => void; userId: string; userName: string; onSuccess: () => void;
}) {
  const [allRoles, setAllRoles] = useState<SysRoleVO[]>([])
  const [assignedRoleIds, setAssignedRoleIds] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    Promise.all([
      rbacApi.listRoles(),
      rbacApi.getUserRoles(userId),
    ]).then(([roles, userRoles]) => {
      setAllRoles(Array.isArray(roles) ? roles : [])
      const assigned = Array.isArray(userRoles) ? userRoles : []
      setAssignedRoleIds(new Set(assigned.map(r => r.id)))
    }).catch(e => setError(e.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [open, userId])

  const handleSave = async () => {
    setSaving(true)
    try {
      await rbacApi.assignRolesToUser(userId, Array.from(assignedRoleIds))
      onOpenChange(false)
      onSuccess()
    } catch (e: any) {
      setError(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>分配角色 - {userName}</DialogTitle>
          <DialogDescription>选择该用户拥有的角色</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </div>
        ) : (
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {allRoles.map(role => (
              <label key={role.id}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors hover:bg-muted/50',
                  assignedRoleIds.has(role.id) && 'border-primary bg-primary/5',
                )}
              >
                <input
                  type="checkbox"
                  checked={assignedRoleIds.has(role.id)}
                  onChange={() => setAssignedRoleIds(prev => {
                    const next = new Set(prev)
                    if (next.has(role.id)) next.delete(role.id); else next.add(role.id)
                    return next
                  })}
                  className="rounded shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{role.roleName}</div>
                  <div className="text-xs text-muted-foreground">{role.roleCode}{role.description ? ` · ${role.description}` : ''}</div>
                </div>
                <Badge variant={role.status === 'active' ? 'default' : 'secondary'} className="text-[10px] shrink-0">
                  {role.status === 'active' ? '启用' : '禁用'}
                </Badge>
              </label>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSave} disabled={saving || loading}>
            {saving && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
            保存角色
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
