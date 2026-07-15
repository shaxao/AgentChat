/**
 * 文件工具函数 — 从 FileAttachment 获取浏览器 File 对象
 *
 * 适用场景：
 * - Agent 工具需要将上传文件转存到服务器本地（如 ledger 文件上传）
 * - 文件预览、文件处理等需要 File 对象的场景
 * - 普通对话中需要重新下载 OSS 文件进行二次处理
 */

import type { FileAttachment } from '../store'

/**
 * 从 FileAttachment 获取浏览器 File 对象。
 *
 * 优先级：
 * 1. blob URL（f.url）— 传统文件对话框上传，浏览器内存中可用
 * 2. OSS URL（f.ossUrl）— UI upload 组件上传，需从云端下载
 *
 * @returns File 对象，或 null（无可用源）
 */
export async function getFileFromSource(f: FileAttachment): Promise<File | null> {
  if (f.url) {
    const resp = await fetch(f.url)
    const blob = await resp.blob()
    return new File([blob], f.name, { type: f.type || 'application/octet-stream' })
  }
  if (f.ossUrl) {
    const resp = await fetch(f.ossUrl)
    if (!resp.ok) throw new Error(`OSS download failed: ${resp.status}`)
    const blob = await resp.blob()
    return new File([blob], f.name, { type: f.type || 'application/octet-stream' })
  }
  return null
}
