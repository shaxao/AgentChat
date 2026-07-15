import { useState, useEffect, useCallback } from 'react'
import { userPreferenceApi, type UserModelPreference, type UserModelUsageDaily } from '@/lib/api'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  BarChart3, SlidersHorizontal, RotateCcw, Loader2, AlertCircle,
  ThumbsUp, ThumbsDown, TrendingUp, Clock, Info,
  MessageSquare, Code2, Eye, Image as ImageIcon, Bot,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const STORAGE_KEY = 'model-preference-scene'
const SCENE_TYPES: { value: string; label: string; icon: LucideIcon }[] = [
  { value: 'chat', label: '通用对话', icon: MessageSquare },
  { value: 'code', label: '代码生成', icon: Code2 },
  { value: 'vision', label: '视觉理解', icon: Eye },
  { value: 'image', label: '图片生成', icon: ImageIcon },
  { value: 'agent', label: '智能代理', icon: Bot },
]

function formatMs(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's'
  return ms + 'ms'
}

function formatCost(cost: number): string {
  return '¥' + cost.toFixed(4)
}

export default function ModelPreferencesTab() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [preferences, setPreferences] = useState<UserModelPreference[]>([])
  const [stats, setStats] = useState<UserModelUsageDaily[]>([])
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [selectedScene, setSelectedScene] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || 'chat' }
    catch { return 'chat' }
  })

  // 本地编辑中的权重，key = "modelId:sceneType"
  const [pendingWeights, setPendingWeights] = useState<Record<string, number>>({})

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [prefs, usageStats] = await Promise.all([
        userPreferenceApi.listPreferences(selectedScene),
        userPreferenceApi.getUsageStats(30),
      ])
      setPreferences(prefs || [])
      setStats(usageStats || [])
      // 初始化 pendingWeights
      const weights: Record<string, number> = {}
      ;(prefs || []).forEach(p => {
        weights[`${p.modelId}:${p.sceneType}`] = p.preferenceWeight
      })
      setPendingWeights(prev => ({ ...weights, ...prev }))
    } catch (e: any) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [selectedScene])

  useEffect(() => { fetchData() }, [fetchData])

  const handleSceneChange = (scene: string) => {
    setSelectedScene(scene)
    try { localStorage.setItem(STORAGE_KEY, scene) } catch {}
  }

  const handleWeightChange = (modelId: string, sceneType: string, value: number[]) => {
    setPendingWeights(prev => ({ ...prev, [`${modelId}:${sceneType}`]: value[0] }))
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveMsg('')
    try {
      // 只保存与当前选中场景相关的、且权重有变化的偏好
      const scenePrefs = preferences.filter(p => p.sceneType === selectedScene)
      const prevWeights: Record<string, number> = {}
      scenePrefs.forEach(p => { prevWeights[p.modelId] = p.preferenceWeight })

      const savePromises: Promise<void>[] = []
      for (const p of scenePrefs) {
        const key = `${p.modelId}:${p.sceneType}`
        const newWeight = pendingWeights[key]
        if (newWeight !== undefined && newWeight !== p.preferenceWeight) {
          savePromises.push(
            userPreferenceApi.setManualPreference(p.modelId, p.sceneType, newWeight)
          )
        }
      }
      await Promise.all(savePromises)
      setSaveMsg('保存成功')
      setTimeout(() => setSaveMsg(''), 2000)
      fetchData() // 刷新数据
    } catch (e: any) {
      setSaveMsg(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setSaving(true)
    setSaveMsg('')
    try {
      await userPreferenceApi.resetPreferences(selectedScene)
      setSaveMsg('已恢复默认')
      setTimeout(() => setSaveMsg(''), 2000)
      // 清除本地 pending 权重
      setPendingWeights({})
      fetchData()
    } catch (e: any) {
      setSaveMsg(e.message || '重置失败')
    } finally {
      setSaving(false)
    }
  }

  // 聚合使用统计（按 modelId 汇总）
  const modelStats = stats.reduce<Record<string, { calls: number; success: number; avgTime: number; totalCost: number; tokens: number }>>((acc, s) => {
    if (!acc[s.modelId]) {
      acc[s.modelId] = { calls: 0, success: 0, avgTime: 0, totalCost: 0, tokens: 0 }
    }
    acc[s.modelId].calls += s.callCount || 0
    acc[s.modelId].success += s.successCount || 0
    acc[s.modelId].totalCost += s.totalCost || 0
    acc[s.modelId].tokens += s.totalTokens || 0
    acc[s.modelId].avgTime = acc[s.modelId].calls > 0
      ? Math.round((acc[s.modelId].avgTime * (acc[s.modelId].calls - s.callCount) + (s.avgResponseTime || 0) * s.callCount) / acc[s.modelId].calls)
      : s.avgResponseTime || 0
    return acc
  }, {})

  // 当前场景下的偏好
  const scenePrefs = preferences.filter(p => p.sceneType === selectedScene)

  // 权重转显示（-1~1 → 0~100 百分比显示）
  const weightToPercent = (w: number) => Math.round((w + 1) * 50)
  const percentToWeight = (p: number) => p / 50 - 1

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <AlertCircle className="w-8 h-8 text-destructive" />
        <p className="text-sm">{error}</p>
        <Button variant="outline" size="sm" onClick={fetchData}>重试</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ── 场景切换 ── */}
      <section>
        <div className="flex gap-1.5 flex-wrap">
          {SCENE_TYPES.map(s => (
            <button
              key={s.value}
              onClick={() => handleSceneChange(s.value)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                selectedScene === s.value
                  ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                  : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground'
              }`}
            >
              <s.icon className="w-3.5 h-3.5" />
              {s.label}
            </button>
          ))}
        </div>
      </section>

      {/* ── 使用统计 ── */}
      <section>
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-primary" />
          我的使用统计（近30天）
        </h3>

        {Object.keys(modelStats).length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
            <TrendingUp className="w-8 h-8 opacity-40" />
            <p className="text-sm">暂无使用数据</p>
            <p className="text-xs">使用模型后，统计数据将自动出现在这里</p>
          </div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">模型</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">调用次数</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">成功率</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">总 Token</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">总费用</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" />平均耗时
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(modelStats)
                    .sort((a, b) => b[1].calls - a[1].calls)
                    .map(([modelId, s]) => (
                      <tr key={modelId} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5 font-medium">{modelId}</td>
                        <td className="text-right px-4 py-2.5 tabular-nums">{s.calls.toLocaleString()}</td>
                        <td className="text-right px-4 py-2.5 tabular-nums">
                          <span className={s.calls > 0 && s.success / s.calls < 0.8 ? 'text-orange-500' : ''}>
                            {s.calls > 0 ? Math.round((s.success / s.calls) * 100) + '%' : '-'}
                          </span>
                        </td>
                        <td className="text-right px-4 py-2.5 tabular-nums text-muted-foreground">
                          {s.tokens > 0 ? s.tokens.toLocaleString() : '-'}
                        </td>
                        <td className="text-right px-4 py-2.5 tabular-nums text-muted-foreground">
                          {formatCost(s.totalCost)}
                        </td>
                        <td className="text-right px-4 py-2.5 tabular-nums text-muted-foreground">
                          {s.avgTime > 0 ? formatMs(s.avgTime) : '-'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <Separator />

      {/* ── 场景偏好设置 ── */}
      <section>
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-primary" />
          场景偏好设置
          <Badge variant="secondary" className="text-[10px] font-normal">
            {SCENE_TYPES.find(s => s.value === selectedScene)?.label || selectedScene}
          </Badge>
        </h3>

        {scenePrefs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
            <SlidersHorizontal className="w-8 h-8 opacity-40" />
            <p className="text-sm">该场景暂无偏好数据</p>
            <p className="text-xs">使用模型后系统会自动学习你的偏好</p>
          </div>
        ) : (
          <div className="space-y-3">
            {scenePrefs
              .sort((a, b) => b.preferenceWeight - a.preferenceWeight)
              .map(pref => {
                const key = `${pref.modelId}:${pref.sceneType}`
                const currentWeight = pendingWeights[key] ?? pref.preferenceWeight
                const pct = weightToPercent(currentWeight)

                return (
                  <div key={pref.id} className="rounded-lg border bg-muted/20 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold">{pref.modelId}</span>
                        {pref.source === 'manual' && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">手动</Badge>
                        )}
                        {pref.source === 'auto' && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">自动</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {pref.usageCount > 0 ? (
                          <>
                            <span className="inline-flex items-center gap-1">
                              <ThumbsUp className="w-3 h-3" />{pref.likeCount}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <ThumbsDown className="w-3 h-3" />{pref.dislikeCount}
                            </span>
                            <span>调用 {pref.usageCount} 次</span>
                          </>
                        ) : (
                          <span>从未使用</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <Slider
                        value={[currentWeight]}
                        min={-1}
                        max={1}
                        step={0.1}
                        onValueChange={(v) => handleWeightChange(pref.modelId, pref.sceneType, v)}
                        className="flex-1"
                      />
                      <span className={`text-sm font-mono w-10 text-right tabular-nums ${
                        currentWeight > 0 ? 'text-green-500' :
                        currentWeight < 0 ? 'text-orange-500' :
                        'text-muted-foreground'
                      }`}>
                        {currentWeight > 0 ? '+' : ''}{currentWeight.toFixed(1)}
                      </span>
                    </div>

                    {/* 权重进度条 */}
                    <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          currentWeight > 0.3 ? 'bg-green-500' :
                          currentWeight > 0 ? 'bg-green-300' :
                          currentWeight < -0.3 ? 'bg-orange-500' :
                          currentWeight < 0 ? 'bg-orange-300' :
                          'bg-muted-foreground/30'
                        }`}
                        style={{ width: pct + '%' }}
                      />
                    </div>
                  </div>
                )
              })}
          </div>
        )}
      </section>

      <Separator />

      {/* ── 说明 ── */}
      <section>
        <div className="rounded-lg border bg-blue-50/50 dark:bg-blue-950/20 p-4 space-y-2">
          <p className="text-xs font-medium flex items-center gap-1.5 text-blue-700 dark:text-blue-300">
            <Info className="w-3.5 h-3.5" />
            偏好生效方式
          </p>
          <ul className="text-xs text-blue-600/80 dark:text-blue-300/80 space-y-1 pl-5 list-disc">
            <li>智能路由选择模型时，你的偏好会影响最终决策（权重 9%）</li>
            <li>手动调整的权重优先级高于自动学习</li>
            <li>权重范围 -1 到 +1，正值倾向使用该模型，负值降低优先级</li>
          </ul>
        </div>
      </section>

      {/* ── 操作按钮 ── */}
      <div className="flex items-center justify-between pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={handleReset}
          disabled={saving}
          className="gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
          恢复默认
        </Button>
        <div className="flex items-center gap-3">
          {saveMsg && (
            <span className={`text-xs ${saveMsg.includes('成功') || saveMsg.includes('恢复') ? 'text-green-500' : 'text-destructive'}`}>
              {saveMsg}
            </span>
          )}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving}
            className="gap-1.5"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            保存设置
          </Button>
        </div>
      </div>
    </div>
  )
}
