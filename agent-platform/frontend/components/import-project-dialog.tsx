'use client'

import { useState, useRef } from 'react'
import { projectsApi, type ImportedProject } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { GitBranchPlus, Loader2, FolderGit2, CheckCircle2, XCircle, Upload, FolderUp, FileArchive } from 'lucide-react'

type ImportMode = 'git' | 'upload'

interface Props {
  open: boolean
  onClose: () => void
  onImported?: (project: { project_id: string; name: string }) => void
}

export function ImportProjectDialog({ open, onClose, onImported }: Props) {
  const [mode, setMode] = useState<ImportMode>('git')

  // Git 模式
  const [gitUrl, setGitUrl] = useState('')
  const [gitProjectName, setGitProjectName] = useState('')

  // 上传模式
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploadProjectName, setUploadProjectName] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ project_id: string; name: string; status: string; file_count?: number } | null>(null)

  const handleGitImport = async () => {
    if (!gitUrl.trim()) {
      setError('请输入 Git 仓库地址')
      return
    }
    let name = gitProjectName.trim()
    if (!name) {
      const match = gitUrl.match(/\/([^/]+?)(\.git)?$/)
      if (match) name = match[1]
    }
    if (!name) name = 'imported-project'

    setImporting(true)
    setError('')
    setResult(null)
    try {
      const res = await projectsApi.clone(gitUrl, name)
      setResult(res)
      onImported?.({ project_id: res.project_id, name: res.name })
    } catch (e: any) {
      setError(e.message || '导入失败，请检查 Git 地址是否正确')
    } finally {
      setImporting(false)
    }
  }

  const handleUpload = async () => {
    if (!selectedFile) {
      setError('请选择要上传的文件')
      return
    }
    const name = uploadProjectName.trim() || selectedFile.name.replace(/\.[^.]+$/, '')

    setImporting(true)
    setError('')
    setResult(null)
    try {
      const res = await projectsApi.upload(selectedFile, name)
      setResult(res)
      onImported?.({ project_id: res.project_id, name: res.name })
    } catch (e: any) {
      setError(e.message || '上传失败，请检查文件格式')
    } finally {
      setImporting(false)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setSelectedFile(file)
      if (!uploadProjectName) {
        setUploadProjectName(file.name.replace(/\.[^.]+$/, ''))
      }
      setError('')
    }
  }

  const handleImport = () => {
    if (mode === 'git') handleGitImport()
    else handleUpload()
  }

  const canSubmit = mode === 'git' ? gitUrl.trim() : !!selectedFile

  const reset = () => {
    setGitUrl('')
    setGitProjectName('')
    setSelectedFile(null)
    setUploadProjectName('')
    setError('')
    setResult(null)
    setMode('git')
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); reset() } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderGit2 className="w-5 h-5 text-primary" />
            导入项目
          </DialogTitle>
          <DialogDescription>
            从 Git 仓库克隆或上传本地项目压缩包
          </DialogDescription>
        </DialogHeader>

        {/* 模式切换 */}
        {!result && (
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => { setMode('git'); setError('') }}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition border',
                mode === 'git'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-secondary text-secondary-foreground border-transparent hover:border-border'
              )}
            >
              <GitBranchPlus className="w-4 h-4" />
              Git 克隆
            </button>
            <button
              onClick={() => { setMode('upload'); setError('') }}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition border',
                mode === 'upload'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-secondary text-secondary-foreground border-transparent hover:border-border'
              )}
            >
              <Upload className="w-4 h-4" />
              本地上传
            </button>
          </div>
        )}

        <div className="space-y-4 mt-2">
          {!result ? (
            <>
              {mode === 'git' ? (
                <>
                  <div>
                    <label className="text-sm font-medium mb-1 block">Git 仓库地址</label>
                    <input
                      value={gitUrl}
                      onChange={(e) => setGitUrl(e.target.value)}
                      placeholder="https://github.com/user/repo.git"
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
                      disabled={importing}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1 block">
                      项目名称 <span className="text-muted-foreground font-normal">（可选，自动从 URL 提取）</span>
                    </label>
                    <input
                      value={gitProjectName}
                      onChange={(e) => setGitProjectName(e.target.value)}
                      placeholder="my-project"
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      disabled={importing}
                    />
                  </div>
                </>
              ) : (
                <>
                  {/* 文件上传区域 */}
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      'border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition',
                      selectedFile
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50 hover:bg-secondary/50'
                    )}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".zip,.tar,.tar.gz,.tgz"
                      className="hidden"
                      onChange={handleFileSelect}
                    />
                    {selectedFile ? (
                      <div className="flex items-center justify-center gap-3">
                        <FileArchive className="w-8 h-8 text-primary" />
                        <div className="text-left">
                          <p className="text-sm font-medium">{selectedFile.name}</p>
                          <p className="text-xs text-muted-foreground">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</p>
                        </div>
                      </div>
                    ) : (
                      <>
                        <FolderUp className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
                        <p className="text-sm font-medium">点击选择文件</p>
                        <p className="text-xs text-muted-foreground mt-1">支持 .zip / .tar / .tar.gz，最大 100MB</p>
                      </>
                    )}
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1 block">
                      项目名称 <span className="text-muted-foreground font-normal">（可选，默认使用文件名）</span>
                    </label>
                    <input
                      value={uploadProjectName}
                      onChange={(e) => setUploadProjectName(e.target.value)}
                      placeholder="my-project"
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                      disabled={importing}
                    />
                  </div>
                </>
              )}

              {error && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 text-sm">
                  <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  {error}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => { onClose(); reset() }}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-secondary transition"
                  disabled={importing}
                >
                  取消
                </button>
                <button
                  onClick={handleImport}
                  disabled={importing || !canSubmit}
                  className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-50 transition"
                >
                  {importing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : mode === 'git' ? (
                    <GitBranchPlus className="w-4 h-4" />
                  ) : (
                    <Upload className="w-4 h-4" />
                  )}
                  {importing ? (mode === 'git' ? '克隆中...' : '上传中...') : (mode === 'git' ? '导入项目' : '上传项目')}
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-lg bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300">
                <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">项目导入成功！</p>
                  <p className="text-sm mt-1">
                    项目 <code className="bg-green-200 dark:bg-green-900 px-1 rounded">{result.name}</code> 已导入。
                  </p>
                  <p className="text-xs mt-2 text-green-600 dark:text-green-400">
                    ID: {result.project_id} · 状态: {result.status}
                    {result.file_count !== undefined ? ` · ${result.file_count} 个文件` : ''}
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={reset}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-secondary transition"
                >
                  导入新项目
                </button>
                <button
                  onClick={() => { onClose(); reset() }}
                  className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition"
                >
                  完成
                </button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
