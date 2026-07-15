import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { X, BookOpen, Code, Plug, Zap, Shield, ArrowRight, Copy, Check } from 'lucide-react'

interface AgentDocsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type DocSection = 'overview' | 'quickstart' | 'manifest' | 'tools' | 'api' | 'faq'

const sections: { id: DocSection; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: '概述', icon: <BookOpen className="w-3.5 h-3.5" /> },
  { id: 'quickstart', label: '快速开始', icon: <Zap className="w-3.5 h-3.5" /> },
  { id: 'manifest', label: 'Manifest 规范', icon: <Code className="w-3.5 h-3.5" /> },
  { id: 'tools', label: 'Tool 定义', icon: <Plug className="w-3.5 h-3.5" /> },
  { id: 'api', label: 'API 参考', icon: <ArrowRight className="w-3.5 h-3.5" /> },
  { id: 'faq', label: 'FAQ', icon: <Shield className="w-3.5 h-3.5" /> },
]

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="absolute top-2 right-2 p-1 rounded hover:bg-muted transition-colors"
      title="复制"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
    </button>
  )
}

function CodeBlock({ code, lang = 'json' }: { code: string; lang?: string }) {
  return (
    <div className="relative">
      <CopyButton text={code} />
      <pre className="bg-muted/60 border rounded-lg p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export default function AgentDocsDialog({ open, onOpenChange }: AgentDocsDialogProps) {
  const [activeSection, setActiveSection] = useState<DocSection>('overview')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <BookOpen className="w-5 h-5 text-primary" />
            Skill 开放平台 · 开发者文档
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-1 overflow-hidden" style={{ maxHeight: 'calc(90vh - 65px)' }}>
          {/* 左侧导航 */}
          <nav className="w-48 shrink-0 border-r bg-muted/20 p-3 space-y-1 overflow-y-auto">
            {sections.map(s => (
              <button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-left ${
                  activeSection === s.id
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {s.icon}
                {s.label}
              </button>
            ))}
          </nav>

          {/* 右侧内容 */}
          <div className="flex-1 p-6 overflow-y-auto space-y-4 text-sm leading-relaxed">
            {activeSection === 'overview' && <OverviewSection />}
            {activeSection === 'quickstart' && <QuickstartSection />}
            {activeSection === 'manifest' && <ManifestSection />}
            {activeSection === 'tools' && <ToolsSection />}
            {activeSection === 'api' && <ApiSection />}
            {activeSection === 'faq' && <FaqSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ────────── 各文档 Section ──────────

function OverviewSection() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Skill 开放平台</h2>
      <p className="text-muted-foreground">
        本平台提供标准化的 Skill 注册、发现和执行框架。任何人都可以将自己的 Skill 应用注册到平台，
        让其他用户方便地发现和使用。
      </p>

      <div className="grid grid-cols-3 gap-3">
        {[
          { title: '注册', desc: '通过 API 或界面注册你的 Skill', color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
          { title: '发现', desc: '搜索和浏览平台上的所有 Skill', color: 'bg-green-500/10 text-green-600 dark:text-green-400' },
          { title: '执行', desc: 'ReAct 循环自动调度工具调用', color: 'bg-purple-500/10 text-purple-600 dark:text-purple-400' },
        ].map(item => (
          <div key={item.title} className="rounded-xl border p-4">
            <Badge className={`mb-2 ${item.color}`}>{item.title}</Badge>
            <p className="text-xs text-muted-foreground">{item.desc}</p>
          </div>
        ))}
      </div>

      <h3 className="font-semibold mt-4">核心架构</h3>
      <div className="bg-muted/40 rounded-lg p-4 font-mono text-xs">
        <p>用户消息 → LLM（携带 Skill 的 tools 定义）</p>
        <p>  ↓ 解析 tool_calls</p>
        <p>ToolExecutor.execute(toolName, args)</p>
        <p>  ├─ 内置工具 → 本地执行（如台账工具）</p>
        <p>  └─ 远程工具 → HTTP POST 到 endpoint</p>
        <p>  ↓ 返回 tool_result</p>
        <p>LLM 继续推理 → 最终回复 / 继续调用</p>
      </div>

      <h3 className="font-semibold mt-4">关键概念</h3>
      <div className="space-y-2">
        <div className="flex gap-3">
          <Badge variant="outline" className="shrink-0 h-6">Agent</Badge>
          <p className="text-xs text-muted-foreground">一个具备特定能力的 AI 应用，包含系统提示词、推荐模型和一组工具定义</p>
        </div>
        <div className="flex gap-3">
          <Badge variant="outline" className="shrink-0 h-6">Tool</Badge>
          <p className="text-xs text-muted-foreground">Skill 可调用的函数，支持本地执行（内置）或远程 HTTP 调用</p>
        </div>
        <div className="flex gap-3">
          <Badge variant="outline" className="shrink-0 h-6">Manifest</Badge>
          <p className="text-xs text-muted-foreground">JSON 格式的 Skill 描述文件，遵循标准 Schema，定义了 Skill 的全部配置</p>
        </div>
      </div>
    </div>
  )
}

function QuickstartSection() {
  const registerCode = `curl -X POST https://your-domain/api/v1/agent-registry/register \\
  -H "Authorization: Bearer YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agentId": "my-weather-agent",
    "name": "天气助手",
    "description": "查询全球城市天气信息",
    "categories": ["生活服务", "数据查询"],
    "model": "gpt-4o",
    "systemPrompt": "你是一个天气查询助手。当用户询问天气时，使用 query_weather 工具获取数据并友好地回复。",
    "tools": [
      {
        "name": "query_weather",
        "description": "查询指定城市的天气信息",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string", "description": "城市名" }
          },
          "required": ["city"]
        },
        "endpoint": "https://your-server.com/api/tools/weather",
        "executionMode": "http"
      }
    ]
  }'`

  const endpointCode = `# 你的 HTTP 工具端点（Flask 示例）
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route("/api/tools/weather", methods=["POST"])
def query_weather():
    args = request.json  # {"city": "北京"}
    city = args.get("city", "")
    # ... 调用真实天气 API ...
    return jsonify({
        "result": f"{city}：晴，25°C，湿度45%"
    })

if __name__ == "__main__":
    app.run(port=8000)`

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">快速开始</h2>
      <p className="text-muted-foreground">3 步将你的 Skill 注册到平台</p>

      <div className="space-y-3">
        <div className="flex gap-3 items-start">
          <div className="w-7 h-7 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold shrink-0">1</div>
          <div className="flex-1">
            <h4 className="font-semibold">编写 Skill Manifest</h4>
            <p className="text-xs text-muted-foreground mt-1">定义你的 Skill 名称、系统提示词和工具列表。详见 <button onClick={() => {}} className="text-primary underline">Manifest 规范</button></p>
          </div>
        </div>
        <div className="flex gap-3 items-start">
          <div className="w-7 h-7 rounded-full bg-green-500 text-white flex items-center justify-center text-xs font-bold shrink-0">2</div>
          <div className="flex-1">
            <h4 className="font-semibold">部署工具端点</h4>
            <p className="text-xs text-muted-foreground mt-1">如果你的 Skill 使用远程工具（HTTP 模式），需要部署一个 HTTP 服务来处理工具调用</p>
          </div>
        </div>
        <div className="flex gap-3 items-start">
          <div className="w-7 h-7 rounded-full bg-purple-500 text-white flex items-center justify-center text-xs font-bold shrink-0">3</div>
          <div className="flex-1">
            <h4 className="font-semibold">调用注册 API</h4>
            <p className="text-xs text-muted-foreground mt-1">通过 REST API 将 Skill 注册到平台</p>
          </div>
        </div>
      </div>

      <h3 className="font-semibold mt-4">注册请求示例</h3>
      <CodeBlock code={registerCode} lang="bash" />

      <h3 className="font-semibold mt-4">工具端点示例</h3>
      <CodeBlock code={endpointCode} lang="python" />

      <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-700 dark:text-amber-400">
        <strong>注意：</strong>注册 API 需要用户认证（Bearer Token）。工具端点必须返回 JSON 格式的 <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded">{"{ \"result\": \"...\" }"}</code> 响应。
      </div>
    </div>
  )
}

function ManifestSection() {
  const fullManifest = `{
  "agentId": "my-weather-agent",
  "name": "天气助手",
  "version": "1.0.0",
  "description": "查询全球城市天气，支持当前天气和未来3天预报",
  "categories": ["生活服务", "数据查询"],
  "model": "gpt-4o",
  "temperature": 0.3,
  "maxTokens": 4096,
  "systemPrompt": "你是一个天气查询助手...",
  "tools": [
    {
      "name": "query_weather",
      "description": "查询指定城市的天气信息",
      "parameters": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string",
            "description": "城市名称，如'北京'或'Shanghai'"
          },
          "unit": {
            "type": "string",
            "enum": ["celsius", "fahrenheit"],
            "description": "温度单位"
          }
        },
        "required": ["city"]
      },
      "endpoint": "https://your-server.com/api/tools/weather",
      "executionMode": "http",
      "isDangerous": false
    }
  ],
  "hooks": {
    "onStart": "天气查询会话开始",
    "onDone": "天气查询完成"
  },
  "icon": "🌤️",
  "author": "your-name",
  "status": "active"
}`

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Manifest 规范</h2>
      <p className="text-muted-foreground">Skill Manifest 是 JSON 格式的配置文件，定义了 Skill 的全部行为</p>

      <h3 className="font-semibold">完整示例</h3>
      <CodeBlock code={fullManifest} />

      <h3 className="font-semibold mt-4">字段说明</h3>
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-2 font-semibold">字段</th>
              <th className="text-left p-2 font-semibold">类型</th>
              <th className="text-left p-2 font-semibold">必填</th>
              <th className="text-left p-2 font-semibold">说明</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {[
              ['agentId', 'string', '✅', '唯一标识，仅允许字母数字短横线下划线'],
              ['name', 'string', '✅', '显示名称'],
              ['version', 'string', '❌', '语义化版本号，默认 1.0.0'],
              ['description', 'string', '❌', '功能描述，用于搜索和展示'],
              ['categories', 'string[]', '❌', '分类标签数组'],
              ['model', 'string', '❌', '推荐模型，默认 gpt-4o'],
              ['temperature', 'number', '❌', 'LLM 温度参数，默认 0.1'],
              ['maxTokens', 'number', '❌', '最大输出 Token 数，默认 8192'],
              ['systemPrompt', 'string', '✅', '系统提示词，定义 Skill 角色和行为'],
              ['tools', 'ToolDef[]', '❌', '工具定义数组'],
              ['hooks', 'HooksDef', '❌', '生命周期钩子'],
              ['icon', 'string', '❌', '图标 emoji 或 URL'],
              ['author', 'string', '❌', '作者名称'],
              ['status', 'string', '❌', '状态：active / draft，默认 active'],
            ].map(([field, type, required, desc]) => (
              <tr key={field} className="hover:bg-muted/30">
                <td className="p-2 font-mono text-primary">{field}</td>
                <td className="p-2 text-muted-foreground">{type}</td>
                <td className="p-2 text-center">{required}</td>
                <td className="p-2">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ToolsSection() {
  const toolDefCode = `{
  "name": "query_database",
  "description": "查询数据库中的记录",
  "parameters": {
    "type": "object",
    "properties": {
      "table": {
        "type": "string",
        "description": "表名"
      },
      "conditions": {
        "type": "object",
        "description": "查询条件键值对"
      },
      "limit": {
        "type": "integer",
        "description": "返回记录数上限",
        "default": 10
      }
    },
    "required": ["table"]
  },
  "endpoint": "https://your-server.com/api/tools/query_database",
  "executionMode": "http",
  "isDangerous": false
}`

  const httpCallFlow = `# 平台调用你的工具端点时的请求格式
POST https://your-server.com/api/tools/query_database
Content-Type: application/json

{
  "tool_name": "query_database",
  "arguments": {
    "table": "users",
    "conditions": {"status": "active"},
    "limit": 5
  }
}

# 你需要返回的响应格式（任意 JSON 字符串，LLM 会直接读取）
{
  "result": "找到 3 条活跃用户记录: ..."
}

# 注意：平台使用 HTTP POST 调用，Body 固定为 {tool_name, arguments} 结构`

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Tool 定义规范</h2>
      <p className="text-muted-foreground">每个 Tool 定义遵循 OpenAI Function Calling 格式，并扩展了执行模式</p>

      <h3 className="font-semibold">两种执行模式</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="border rounded-xl p-4">
          <Badge className="mb-2 bg-blue-500/10 text-blue-600">local</Badge>
          <p className="text-xs text-muted-foreground">内置工具，在平台服务端直接执行。如台账生成工具。</p>
          <p className="text-xs text-muted-foreground mt-2">无需提供 endpoint。</p>
        </div>
        <div className="border rounded-xl p-4">
          <Badge className="mb-2 bg-green-500/10 text-green-600">http</Badge>
          <p className="text-xs text-muted-foreground">远程工具，平台通过 HTTP POST 调用你部署的端点。</p>
          <p className="text-xs text-muted-foreground mt-2">需要提供 endpoint URL。</p>
        </div>
      </div>

      <h3 className="font-semibold mt-4">工具定义示例</h3>
      <CodeBlock code={toolDefCode} />

      <h3 className="font-semibold mt-4">HTTP 调用协议</h3>
      <CodeBlock code={httpCallFlow} />

      <h3 className="font-semibold mt-4">参数格式</h3>
      <p className="text-xs text-muted-foreground">
        <code className="bg-muted px-1 rounded">parameters</code> 字段遵循 JSON Schema 规范，
        与 OpenAI Function Calling 的 <code className="bg-muted px-1 rounded">parameters</code> 完全一致。
        支持 <code className="bg-muted px-1 rounded">type</code>、<code className="bg-muted px-1 rounded">properties</code>、
        <code className="bg-muted px-1 rounded">required</code>、<code className="bg-muted px-1 rounded">enum</code>、
        <code className="bg-muted px-1 rounded">default</code> 等标准属性。
      </p>

      <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-700 dark:text-amber-400">
        <strong>安全提示：</strong>标记 <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded">isDangerous: true</code> 的工具会在执行前向用户确认。
      </div>
    </div>
  )
}

function ApiSection() {
  const endpoints = [
    { method: 'POST', path: '/api/v1/agent-registry/register', desc: '注册新 Skill', auth: '✅' },
    { method: 'PUT', path: '/api/v1/agent-registry/{agentId}', desc: '更新 Agent', auth: '✅' },
    { method: 'DELETE', path: '/api/v1/agent-registry/{agentId}', desc: '注销 Skill', auth: '✅' },
    { method: 'GET', path: '/api/v1/agent-registry', desc: '列出所有 Skill', auth: '✅' },
    { method: 'GET', path: '/api/v1/agent-registry/search?q=', desc: '搜索 Agent', auth: '✅' },
    { method: 'GET', path: '/api/v1/agent-registry/{agentId}', desc: '获取 Skill 详情', auth: '✅' },
  ]

  const methodColors: Record<string, string> = {
    GET: 'bg-green-500/10 text-green-600',
    POST: 'bg-blue-500/10 text-blue-600',
    PUT: 'bg-amber-500/10 text-amber-600',
    DELETE: 'bg-red-500/10 text-red-600',
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">API 参考</h2>
      <p className="text-muted-foreground">所有端点需要 Bearer Token 认证</p>

      <h3 className="font-semibold">端点列表</h3>
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-2 font-semibold">方法</th>
              <th className="text-left p-2 font-semibold">路径</th>
              <th className="text-left p-2 font-semibold">说明</th>
              <th className="text-left p-2 font-semibold">认证</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {endpoints.map((ep, i) => (
              <tr key={i} className="hover:bg-muted/30">
                <td className="p-2"><Badge className={`${methodColors[ep.method]} font-mono text-[10px]`}>{ep.method}</Badge></td>
                <td className="p-2 font-mono text-primary text-[11px]">{ep.path}</td>
                <td className="p-2">{ep.desc}</td>
                <td className="p-2 text-center">{ep.auth}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="font-semibold mt-4">注册 Agent</h3>
      <div className="space-y-2">
        <p className="text-xs"><code className="bg-muted px-1 rounded">POST /api/v1/agent-registry/register</code></p>
        <p className="text-xs text-muted-foreground">请求体即为 Manifest 字段，见 Manifest 规范章节。</p>
        <p className="text-xs text-muted-foreground">响应：返回完整的 AgentDetail 对象。</p>
        <p className="text-xs text-muted-foreground">权限：仅创建者可更新/注销自己的 Agent。</p>
      </div>

      <h3 className="font-semibold mt-4">错误码</h3>
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-2 font-semibold">场景</th>
              <th className="text-left p-2 font-semibold">错误信息</th>
            </tr>
          </thead>
          <tbody className="divide-y text-muted-foreground">
            <tr><td className="p-2">agentId 已存在</td><td className="p-2 font-mono">Skill ID already exists</td></tr>
            <tr><td className="p-2">非创建者操作</td><td className="p-2 font-mono">Only the creator can update/delete</td></tr>
            <tr><td className="p-2">内置 Skill 不可删除</td><td className="p-2 font-mono">Cannot delete built-in agent</td></tr>
            <tr><td className="p-2">agentId 格式错误</td><td className="p-2 font-mono">Only letters, numbers, hyphens, underscores</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FaqSection() {
  const faqs = [
    {
      q: '远程工具的端点有什么要求？',
      a: '需要是公网可访问的 HTTPS 地址，接受 POST 请求，请求体为工具参数 JSON，返回 {"result": "..."} 格式的 JSON 响应。响应时间建议不超过 30 秒。',
    },
    {
      q: 'Skill 可以有多少个工具？',
      a: '建议不超过 20 个工具。过多的工具可能导致 LLM 难以选择正确的工具，影响推理质量。',
    },
    {
      q: '我可以更新已注册的 Agent 吗？',
      a: '可以。只有创建者可以更新自己的 Agent，使用 PUT /api/v1/agent-registry/{agentId} 端点。内置 Skill 不可修改。',
    },
    {
      q: '内置 Skill 和用户注册的 Agent 有什么区别？',
      a: '内置 Skill（如台账识别 Agent）由平台提供，使用本地执行的工具，无需外部端点。用户注册的 Agent 通常使用 HTTP 远程工具。',
    },
    {
      q: '模型可以修改吗？',
      a: 'Manifest 中的 model 字段是推荐模型，用户在使用时可以覆盖为其他可用模型。但系统提示词和工具定义会保持不变。',
    },
    {
      q: '如何调试我的 Skill？',
      a: '1) 先通过 API 注册 status 为 "draft" 的 Agent；2) 在聊天界面选择你的 Skill 测试；3) 观察工具调用日志；4) 确认无误后将 status 改为 "active"。',
    },
  ]

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">常见问题</h2>
      <div className="space-y-3">
        {faqs.map((faq, i) => (
          <div key={i} className="border rounded-xl p-4">
            <h4 className="font-semibold text-sm">{faq.q}</h4>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{faq.a}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
