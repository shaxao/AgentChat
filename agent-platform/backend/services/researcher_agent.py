# -*- coding: utf-8 -*-
"""
Researcher Agent — 调研阶段 Agent（v2.0 Provider-agnostic）

v2.0 改动：
- Anthropic SDK → LLMClient 统一抽象
- 工具定义 → ToolDefinition 类
- 模型选择 → 由 Orchestrator 传入配置
"""
import asyncio
import re
import json
import httpx
from datetime import datetime
from typing import Optional

from loguru import logger

from core.config import get_settings
from core.llm_client import LLMClient, ToolDefinition


# ─── 调研工具定义（OpenAI function calling 格式）──────────────
RESEARCHER_TOOLS = [
    ToolDefinition(
        name="web_search",
        description="搜索网络获取最新技术信息",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词（英文效果更佳）"},
                "limit": {"type": "integer", "description": "返回结果数量，默认5"},
            },
            "required": ["query"],
        },
    ),
    ToolDefinition(
        name="read_file",
        description="读取本地文件",
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "文件路径"},
            },
            "required": ["path"],
        },
    ),
]


class ResearcherAgent:
    """
    Researcher Agent — 在任务开始前进行技术调研，
    输出结构化报告作为其他 Agent 的决策依据。

    v2.0: 通过 Orchestrator 传入 LLMClient 配置。
    """

    def __init__(self):
        self._llm: Optional[LLMClient] = None
        self._model: str = ""
        self._settings = get_settings()

    def set_llm_config(self, llm: LLMClient, model: str):
        """由 Orchestrator 设置 LLM 客户端配置"""
        self._llm = llm
        self._model = model

    async def research(
        self,
        task_id: str,
        description: str,
        project_type: str,
        workspace_id: str,
        log_fn=None,
    ) -> dict:
        """
        执行完整调研流程。
        返回: { "recommendations": [...], "tech_stack": {...}, "pitfalls": [...], "best_practices": [...] }
        """
        if not self._llm:
            logger.error("[Researcher] LLM 客户端未初始化！请先调用 set_llm_config()")
            return self._default_recommendations(project_type)

        if log_fn:
            log_fn("info", "🔍 Researcher Agent 启动调研阶段", "researcher")

        system = RESEATCHER_SYSTEM_PROMPT
        user_msg = f"""请对以下项目需求进行技术调研：

项目类型: {project_type}
需求描述: {description}

请完成以下调研任务并以 JSON 格式输出结果：

1. **技术栈推荐** — 根据项目类型推荐最佳技术栈（前端框架、后端框架、数据库、部署方案）
2. **关键库选型** — 列出该类型项目常用的核心库（如 UI 组件库、状态管理、ORM 等）
3. **最佳实践** — 3-5 条该项目开发中应遵循的最佳实践
4. **常见陷阱** — 2-4 个该类型项目容易踩的坑
5. **项目结构** — 推荐的标准目录结构（文本描述）
6. **参考案例** — 2-3 个优秀的开源参考项目（名称 + GitHub 地址）

请用中文输出，JSON 字段名为英文。

输出格式：
{{
  "tech_stack": {{ "frontend": "", "backend": "", "database": "", "deploy": "" }},
  "key_libraries": ["..."],
  "best_practices": ["..."],
  "pitfalls": ["..."],
  "project_structure": "...",
  "reference_projects": [{{ "name": "", "url": "", "why": "" }}],
  "confidence": 0.9
}}
"""

        messages = [{"role": "user", "content": user_msg}]
        findings = {}

        try:
            for iteration in range(3):
                if log_fn:
                    log_fn("info", f"Researcher 第 {iteration + 1} 次迭代", "researcher")

                # ── v2.0: 使用 LLMClient ──
                response = await self._llm.chat(
                    messages=messages,
                    tools=RESEARCHER_TOOLS,
                    system=system,
                )

                text_content = response.content or ""
                tool_results = []

                # ── v2.0: 处理工具调用 ──
                if response.has_tool_calls:
                    for tc in response.tool_calls:
                        tool_name = tc.name
                        tool_args = tc.arguments

                        if log_fn:
                            log_fn("info", f"执行调研工具: {tool_name}", "researcher")

                        result = await self._execute_tool(tool_name, tool_args)
                        tool_results.append(result)

                        messages.append({
                            "role": "assistant",
                            "content": text_content or None,
                            "tool_calls": [{
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                                },
                            }],
                            **({"reasoning_content": response.reasoning_content}
                               if response.reasoning_content else {}),
                        })
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": f"[{tool_name} 结果]\n{result}",
                        })

                # 尝试解析 JSON
                json_match = re.search(r'\{[\s\S]*\}', text_content)
                if json_match:
                    try:
                        findings = json.loads(json_match.group())
                        if log_fn:
                            log_fn("success",
                                   f"调研完成，建议已生成（置信度: {findings.get('confidence', '?')}）",
                                   "researcher")
                        break
                    except json.JSONDecodeError:
                        pass

                if tool_results:
                    text_content += "\n\n---\n工具调研结果:\n" + "\n".join(tool_results[:3])

                if not response.has_tool_calls:
                    assistant_msg = {"role": "assistant", "content": text_content}
                    if response.reasoning_content:
                        assistant_msg["reasoning_content"] = response.reasoning_content
                    messages.append(assistant_msg)

                if iteration >= 2:
                    break

        except Exception as e:
            logger.warning(f"[Researcher] 调研失败: {e}")
            if log_fn:
                log_fn("warn", f"调研异常: {e}，使用默认建议", "researcher")
            findings = self._default_recommendations(project_type)

        return findings

    async def _execute_tool(self, tool_name: str, args: dict) -> str:
        """执行调研工具"""
        if tool_name == "web_search":
            return await self._web_search(args.get("query", ""), args.get("limit", 5))
        elif tool_name == "read_file":
            try:
                from pathlib import Path
                content = Path(args["path"]).read_text(encoding="utf-8")[:1000]
                return f"[文件内容]\n{content}"
            except Exception as e:
                return f"[错误] {e}"
        return "[未知工具]"

    async def _web_search(self, query: str, limit: int = 5) -> str:
        """通过 DuckDuckGo HTML 抓取获取搜索结果"""
        if not query.strip():
            return "[]"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                params = {"q": query, "kl": "wt-wt"}
                res = await client.get("https://html.duckduckgo.com/html/", params=params)
                res.raise_for_status()

                results = []
                import re as _re
                items = _re.findall(
                    r'<a class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>.*?<a class="result__snippet"[^>]*>(.*?)</a>',
                    res.text,
                    _re.DOTALL,
                )
                for url, title_raw, snippet_raw in items[:limit]:
                    title = _re.sub(r'<[^>]+>', '', title_raw).strip()
                    snippet = _re.sub(r'<[^>]+>', '', snippet_raw).strip()
                    results.append(f"- [{title}]({url})\n  {snippet[:200]}")

                if not results:
                    return f"[搜索 '{query}' 无结果]"
                return "\n".join(results)
        except Exception as e:
            return f"[搜索失败: {e}]"

    def _default_recommendations(self, project_type: str) -> dict:
        """当调研失败时返回默认推荐"""
        defaults = {
            "nextjs": {
                "tech_stack": {"frontend": "Next.js 15 + React 19", "backend": "Next.js API Routes / FastAPI", "database": "PostgreSQL + Prisma", "deploy": "Vercel"},
                "key_libraries": ["Tailwind CSS", "shadcn/ui", "Zustand", "React Query", "Zod"],
                "best_practices": ["App Router", "Server Components", "TypeScript strict", "T3 Stack模式"],
                "pitfalls": ["过度使用客户端组件", "忽视SEO优化", "不恰当的数据获取模式"],
                "project_structure": "app/ (pages + api) + components/ + lib/ + types/",
                "reference_projects": [],
                "confidence": 0.5,
            },
            "react": {
                "tech_stack": {"frontend": "React 19 + Vite", "backend": "Express/NestJS", "database": "PostgreSQL", "deploy": "Vercel / Netlify"},
                "key_libraries": ["React Router v7", "TanStack Query", "Zustand", "Tailwind CSS"],
                "best_practices": ["函数组件 + Hooks", "TypeScript", "组件库分形"],
                "pitfalls": ["过度重构", "状态管理混乱", "忽视性能优化"],
                "project_structure": "src/ (components/ + pages/ + hooks/ + api/)",
                "reference_projects": [],
                "confidence": 0.5,
            },
        }
        return defaults.get(project_type, defaults["nextjs"])


RESEATCHER_SYSTEM_PROMPT = """你是一个高级技术调研专家 (Senior Research Engineer)。

你的职责是在 Agent 开始编码前，通过搜索和分析给出专业、客观的技术建议。

工作原则：
- 给出具体、可操作的建议，而非泛泛而谈
- 引用真实项目或官方文档作为参考
- 指出常见误区和潜在风险
- 考虑开发效率和长期维护性的平衡

你的调研报告将直接影响其他 Agent 的技术决策，请务必准确、严谨。"""


researcher_agent = ResearcherAgent()
