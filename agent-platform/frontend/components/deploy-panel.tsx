'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, Rocket, Box, ExternalLink, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import { deployApi } from '@/lib/api'

interface DeployResult {
  ok: boolean
  url?: string
  image?: string
  deploy_id?: string
  status?: string
  error?: string
}

interface DeployPanelProps {
  workspaceId: string
  vercelToken?: string
  defaultProjectName?: string
  className?: string
}

export function DeployPanel({
  workspaceId,
  vercelToken: initialVercelToken,
  defaultProjectName,
  className,
}: DeployPanelProps) {
  const [vercelToken, setVercelToken] = useState(initialVercelToken || '')
  const [projectName, setProjectName] = useState(defaultProjectName || '')
  const [dockerRegistry, setDockerRegistry] = useState('registry.vercel.com')
  const [dockerTag, setDockerTag] = useState('')
  const [deploying, setDeploying] = useState<'vercel' | 'docker' | null>(null)
  const [result, setResult] = useState<DeployResult | null>(null)
  const [deployingLogs, setDeployingLogs] = useState<string[]>([])

  const log = (msg: string) => setDeployingLogs(prev => [...prev.slice(-20), `[${new Date().toLocaleTimeString()}] ${msg}`])

  const deployToVercel = async () => {
    if (!vercelToken.trim()) {
      setResult({ ok: false, error: '请输入 Vercel Token' })
      return
    }
    setDeploying('vercel')
    setResult(null)
    setDeployingLogs([])
    log('🚀 正在打包项目...')

    try {
      log(`📤 推送到 Vercel (project: ${projectName || workspaceId})...`)

      const data = await deployApi.toVercel(workspaceId, vercelToken, projectName || undefined)
      if (data.ok) {
        log('✅ 部署完成！')
        setResult({ ok: true, url: data.url, deploy_id: data.deploy_id, status: data.status })
      } else {
        log(`❌ 部署失败: ${data.error}`)
        setResult({ ok: false, error: data.error })
      }
    } catch (e: any) {
      log(`❌ 异常: ${e.message}`)
      setResult({ ok: false, error: e.message })
    } finally {
      setDeploying(null)
    }
  }

  const deployDocker = async () => {
    setDeploying('docker')
    setResult(null)
    setDeployingLogs([])
    log('🐳 正在构建 Docker 镜像...')

    try {
      log(`📦 镜像 tag: ${dockerTag || `${dockerRegistry}/autocode/${workspaceId}:latest`}`)

      const data = await deployApi.toDocker(workspaceId, dockerRegistry, dockerTag || undefined)
      if (data.ok) {
        log('✅ 镜像构建并推送完成！')
        setResult({ ok: true, image: data.image, status: data.status })
      } else {
        log(`❌ 失败: ${data.error}`)
        setResult({ ok: false, error: data.error })
      }
    } catch (e: any) {
      log(`❌ 异常: ${e.message}`)
      setResult({ ok: false, error: e.message })
    } finally {
      setDeploying(null)
    }
  }

  return (
    <div className={cn('border rounded-xl overflow-hidden', className)}>
      {/* Header */}
      <div className="px-4 py-3 border-b bg-muted/20 flex items-center gap-2">
        <Rocket className="w-4 h-4 text-primary" />
        <span className="text-sm font-medium">一键部署</span>
      </div>

      <div className="p-4 space-y-5">
        {/* Vercel 部署 */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <svg className="w-4 h-4" viewBox="0 0 76 76" fill="currentColor">
              <path d="M38 0 0 76h76L38 0zm0 59.7L65.5 76H10.5L38 59.7z"/>
            </svg>
            Vercel 部署
          </h4>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">项目名称（可选）</label>
            <input
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              placeholder={workspaceId}
              className="w-full border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Vercel Token
              {vercelToken && <span className="ml-2 text-green-500">● 已配置</span>}
            </label>
            <input
              type="password"
              value={vercelToken}
              onChange={e => setVercelToken(e.target.value)}
              placeholder="请输入 Vercel API Token"
              className="w-full border rounded-lg px-3 py-2 text-sm bg-background font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-xs text-muted-foreground mt-1">
              从 vercel.com/account/tokens 获取 Token
            </p>
          </div>
          <button
            onClick={deployToVercel}
            disabled={deploying === 'vercel'}
            className={cn(
              'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition',
              deploying === 'vercel'
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'bg-black text-white hover:opacity-90'
            )}
          >
            {deploying === 'vercel' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> 部署中...</>
            ) : (
              <><Rocket className="w-4 h-4" /> 部署到 Vercel</>
            )}
          </button>
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-background px-3 text-xs text-muted-foreground">或</span>
          </div>
        </div>

        {/* Docker 部署 */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <Box className="w-4 h-4" />
            Docker 镜像推送
          </h4>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">镜像仓库 URL</label>
            <input
              value={dockerRegistry}
              onChange={e => setDockerRegistry(e.target.value)}
              placeholder="registry.vercel.com"
              className="w-full border rounded-lg px-3 py-2 text-sm bg-background font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">镜像 Tag（可选）</label>
            <input
              value={dockerTag}
              onChange={e => setDockerTag(e.target.value)}
              placeholder={`${dockerRegistry}/autocode/${workspaceId}:latest`}
              className="w-full border rounded-lg px-3 py-2 text-sm bg-background font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <button
            onClick={deployDocker}
            disabled={deploying === 'docker'}
            className={cn(
              'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium border transition',
              deploying === 'docker'
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'border-blue-500 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'
            )}
          >
            {deploying === 'docker' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> 构建中...</>
            ) : (
              <><Box className="w-4 h-4" /> 构建并推送镜像</>
            )}
          </button>
        </div>

        {/* 结果展示 */}
        {result && (
          <div className={cn(
            'rounded-lg p-4 space-y-2',
            result.ok ? 'bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800'
          )}>
            <div className="flex items-center gap-2">
              {result.ok ? (
                <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
              ) : (
                <XCircle className="w-5 h-5 text-red-600 shrink-0" />
              )}
              <span className={cn('font-medium text-sm', result.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400')}>
                {result.ok ? '部署成功！' : '部署失败'}
              </span>
            </div>
            {result.url && (
              <div className="flex items-center gap-2">
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400 hover:underline ml-7"
                >
                  {result.url} <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
            {result.image && (
              <p className="text-sm text-green-700 dark:text-green-400 ml-7 font-mono">{result.image}</p>
            )}
            {result.error && (
              <p className="text-sm text-red-700 dark:text-red-400 ml-7">{result.error}</p>
            )}
          </div>
        )}

        {/* 部署日志 */}
        {deployingLogs.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium">部署日志</p>
            <pre className="text-xs font-mono bg-[#0d1117] text-[#c9d1d9] p-3 rounded-lg overflow-x-auto max-h-[150px] overflow-y-auto">
              {deployingLogs.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
