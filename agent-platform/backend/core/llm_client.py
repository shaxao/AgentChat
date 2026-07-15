# -*- coding: utf-8 -*-
"""
Provider-agnostic LLM Client — 借鉴 OpenCode 的 Provider 抽象层设计

核心思路：
- OpenAI-compatible API 作为统一接口（DeepSeek/Kimi/Qwen 全兼容）
- Anthropic 原生协议作为特殊适配器
- 工具定义统一使用 OpenAI function calling 格式
- 模型选择通过 capabilities 标签驱动，不硬编码提供商

参考：OpenCode 的 Vercel AI SDK 统一 21 个 Provider 的设计
"""
import json
import asyncio
import os
from typing import Optional
from dataclasses import dataclass, field

import httpx
from loguru import logger

from services.usage_reporter import (
    current_usage_context,
    extract_token_usage,
    monotonic_ms,
    report_usage,
)


# ─── 数据结构 ────────────────────────────────────────────────────

@dataclass
class ToolCall:
    """统一的工具调用表示"""
    id: str
    name: str
    arguments: dict


@dataclass
class LLMResponse:
    """统一的 LLM 响应"""
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = "stop"
    model: str = ""
    usage: dict = field(default_factory=dict)
    # DeepSeek 推理模型的思维链内容，后续请求需传回
    reasoning_content: str = ""

    @property
    def has_tool_calls(self) -> bool:
        return len(self.tool_calls) > 0


@dataclass
class ToolDefinition:
    """统一的工具定义（OpenAI function calling 格式）"""
    name: str
    description: str
    parameters: dict  # JSON Schema

    def to_openai(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    @classmethod
    def from_anthropic_mcp(cls, mcp_def: dict) -> "ToolDefinition":
        """从 Anthropic MCP 格式转换"""
        return cls(
            name=mcp_def["name"],
            description=mcp_def.get("description", ""),
            parameters=mcp_def.get("input_schema", {"type": "object", "properties": {}}),
        )


# ─── LLM 客户端 ──────────────────────────────────────────────────

class LLMClient:
    """
    Provider-agnostic LLM 客户端。

    使用方式：
        client = LLMClient(
            api_key="sk-xxx",
            base_url="https://api.deepseek.com/v1",
            model="deepseek-chat",
            provider="openai-compat",  # 或 "anthropic"
        )
        response = await client.chat(messages, tools=[...])
    """

    def __init__(
        self,
        api_key: str,
        base_url: str,
        model: str,
        provider: str = "openai-compat",
        source_provider: str | None = None,
        channel_id: str | None = None,
        billing_model: str | None = None,
        temperature: float = 0.1,
        max_tokens: int = 8192,
        timeout: float = 120.0,
    ):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.provider = provider
        self.source_provider = source_provider or provider
        self.channel_id = channel_id
        self.billing_model = billing_model or model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.timeout = timeout

    async def chat(
        self,
        messages: list[dict],
        tools: list[ToolDefinition] | None = None,
        system: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        stream: bool = False,      # 预留，暂未实现流式
    ) -> LLMResponse:
        """
        发送对话请求，返回统一格式的响应。

        Args:
            messages: 消息列表 [{"role": "user", "content": "..."}]
            tools: 工具定义列表
            system: 系统提示词（OpenAI 兼容时注入为 system message）
            temperature: 覆盖默认温度
            max_tokens: 覆盖默认 max_tokens
            stream: 是否流式（暂未实现）

        Returns:
            LLMResponse with content and optional tool_calls
        """
        started = monotonic_ms()
        usage_ctx = current_usage_context()
        try:
            if self.provider == "muhugochat-proxy":
                response = await self._muhugochat_proxy_chat(messages, tools, system, temperature, max_tokens)
            elif self.provider == "anthropic":
                response = await self._anthropic_chat(messages, tools, system, temperature, max_tokens)
            else:
                response = await self._openai_compat_chat(messages, tools, system, temperature, max_tokens)
        except Exception as exc:
            await report_usage(
                model=self.billing_model,
                input_tokens=0,
                output_tokens=0,
                latency_ms=monotonic_ms() - started,
                status="error",
                error_msg=str(exc),
                provider=self.source_provider,
                channel_id=self.channel_id,
                context=usage_ctx,
            )
            raise

        input_tokens, cached_input_tokens, output_tokens = extract_token_usage(response.usage)
        await report_usage(
            model=self.billing_model,
            input_tokens=input_tokens,
            cached_input_tokens=cached_input_tokens,
            output_tokens=output_tokens,
            latency_ms=monotonic_ms() - started,
            status="success",
            provider=self.source_provider,
            channel_id=self.channel_id,
            context=usage_ctx,
        )
        return response

    async def _muhugochat_proxy_chat(
        self,
        messages: list[dict],
        tools: list[ToolDefinition] | None,
        system: str | None,
        temperature: float | None,
        max_tokens: int | None,
    ) -> LLMResponse:
        """Call the Java chat system internal completion API."""
        url = f"{self.base_url.rstrip('/')}/internal/chat/completions"
        body: dict = {
            "model": self.model,
            "system": system,
            "messages": messages,
            "temperature": temperature if temperature is not None else self.temperature,
            "maxTokens": max_tokens if max_tokens is not None else self.max_tokens,
            "thinking": False,
        }
        if tools:
            body["tools"] = [t.to_openai() for t in tools]

        headers = {
            "X-Internal-Api-Key": self.api_key,
            "Content-Type": "application/json",
        }
        logger.info(
            f"[LLM-MuhugoChat] -> {self.model} URL={url} "
            f"msgs={len(messages)} tools={len(tools or [])}"
        )
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(url, json=body, headers=headers)
            if resp.status_code != 200:
                raise RuntimeError(f"MuhugoChat internal chat error {resp.status_code}: {resp.text[:500]}")
            payload = resp.json()

        code = payload.get("code", 200 if payload.get("success") is True else None)
        if code not in (0, 200, "0", "200"):
            raise RuntimeError(
                f"MuhugoChat internal chat failed: {payload.get('message') or str(payload)[:300]}"
            )
        data = payload.get("data")
        if not isinstance(data, dict):
            raise RuntimeError(f"MuhugoChat internal chat returned invalid data: {str(payload)[:300]}")
        return self._parse_openai_response(data)

    # ── OpenAI-compatible 实现 ────────────────────────────────

    async def _openai_compat_chat(
        self,
        messages: list[dict],
        tools: list[ToolDefinition] | None,
        system: str | None,
        temperature: float | None,
        max_tokens: int | None,
    ) -> LLMResponse:
        """通过 OpenAI-compatible API 发送请求"""
        url = f"{self.base_url}/chat/completions"
        # 解决部分代理 URL 末尾重复 /v1 的问题
        if "/v1/v1/" in url:
            url = url.replace("/v1/v1/", "/v1/")

        # 构建请求体
        body: dict = {
            "model": self.model,
            "temperature": temperature if temperature is not None else self.temperature,
            "max_tokens": max_tokens if max_tokens is not None else self.max_tokens,
            "stream": False,
        }
        thinking_enabled = os.getenv("AUTOCODE_ENABLE_THINKING", "false").lower() in ("1", "true", "yes", "on")
        if thinking_enabled:
            body["_thinking"] = True
            body["_thinking_budget"] = int(os.getenv("AUTOCODE_THINKING_BUDGET", "8192") or "8192")

        # 构建消息列表（system prompt 前置）
        api_messages = []
        if system:
            api_messages.append({"role": "system", "content": system})
        api_messages.extend(messages)

        body["messages"] = api_messages

        # 附加工具定义
        if tools:
            body["tools"] = [t.to_openai() for t in tools]
            # DeepSeek 需要显式设置 tool_choice
            body["tool_choice"] = "auto"

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        logger.info(f"[LLM] → {self.model} ({self.provider}) URL={url} msgs={len(api_messages)} tools={len(tools or [])}")

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(url, json=body, headers=headers)
            if resp.status_code in (400, 422) and thinking_enabled:
                retry_body = dict(body)
                retry_body.pop("_thinking", None)
                retry_body.pop("_thinking_budget", None)
                logger.warning(
                    f"[LLM] {self.model} rejected thinking params, retrying without thinking: "
                    f"HTTP {resp.status_code} {resp.text[:200]}"
                )
                resp = await client.post(url, json=retry_body, headers=headers)

            if resp.status_code != 200:
                error_text = resp.text[:500]
                logger.error(f"[LLM] HTTP {resp.status_code}: {error_text}")
                raise RuntimeError(f"LLM API error {resp.status_code}: {error_text}")

            data = resp.json()

        return self._parse_openai_response(data)

    def _parse_openai_response(self, data: dict) -> LLMResponse:
        """解析 OpenAI-compatible 响应"""
        choice = data.get("choices", [{}])[0]
        message = choice.get("message", {})
        finish = choice.get("finish_reason", "stop")

        # 文本内容
        raw_content = message.get("content")
        if isinstance(raw_content, str):
            content = raw_content
        elif isinstance(raw_content, list):
            parts: list[str] = []
            for block in raw_content:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict):
                    text = block.get("text") or block.get("content")
                    if isinstance(text, str):
                        parts.append(text)
            content = "".join(parts)
        else:
            content = ""

        # DeepSeek 推理模型的思维链内容
        reasoning_content = message.get("reasoning_content") or ""

        # 工具调用
        tool_calls = []
        raw_calls = message.get("tool_calls") or []
        for tc in raw_calls:
            func = tc.get("function", {})
            args_str = func.get("arguments", "{}")
            try:
                args = json.loads(args_str) if isinstance(args_str, str) else args_str
            except json.JSONDecodeError:
                logger.warning(f"[LLM] 工具参数 JSON 解析失败: {args_str[:200]}")
                args = {}
            tool_calls.append(ToolCall(
                id=tc.get("id", ""),
                name=func.get("name", ""),
                arguments=args,
            ))

        legacy_call = message.get("function_call")
        if legacy_call and not tool_calls:
            args_str = legacy_call.get("arguments", "{}")
            try:
                args = json.loads(args_str) if isinstance(args_str, str) else (args_str or {})
            except json.JSONDecodeError:
                logger.warning(f"[LLM] legacy function_call arguments JSON parse failed: {str(args_str)[:200]}")
                args = {}
            tool_calls.append(ToolCall(
                id="legacy_function_call",
                name=legacy_call.get("name", ""),
                arguments=args,
            ))

        usage = data.get("usage", {})

        logger.info(
            f"[LLM] ← {self.model} "
            f"finish={finish} content_len={len(content)} "
            f"tool_calls={len(tool_calls)} "
            f"reasoning_len={len(reasoning_content)} "
            f"tokens={usage.get('total_tokens', '?')}"
        )

        if not content.strip() and not tool_calls:
            logger.warning(
                "[LLM] empty assistant message: "
                f"model={self.model} finish={finish} "
                f"message_keys={list(message.keys())} "
                f"reasoning_len={len(reasoning_content)} "
                f"choice_keys={list(choice.keys())}"
            )
            raise RuntimeError(
                f"LLM returned empty assistant message: model={self.model}, "
                f"finish={finish}, reasoning_len={len(reasoning_content)}"
            )

        return LLMResponse(
            content=content,
            tool_calls=tool_calls,
            finish_reason=finish,
            model=data.get("model", self.model),
            usage=usage,
            reasoning_content=reasoning_content,
        )

    # ── Anthropic 原生实现（向后兼容）──────────────────────────

    async def _anthropic_chat(
        self,
        messages: list[dict],
        tools: list[ToolDefinition] | None,
        system: str | None,
        temperature: float | None,
        max_tokens: int | None,
    ) -> LLMResponse:
        """通过 Anthropic 原生 API 发送请求（向后兼容）"""
        try:
            import anthropic
        except ImportError:
            raise RuntimeError(
                "Anthropic 原生模式需要安装 anthropic 包: pip install anthropic"
            )

        client = anthropic.AsyncAnthropic(
            api_key=self.api_key,
            base_url=self.base_url if self.base_url else None,
        )

        # 转换工具格式：OpenAI function → Anthropic MCP
        anthropic_tools = None
        if tools:
            anthropic_tools = [
                {
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                }
                for t in tools
            ]

        kwargs = {
            "model": self.model,
            "max_tokens": max_tokens if max_tokens is not None else self.max_tokens,
            "messages": messages,
        }
        if system:
            kwargs["system"] = system
        if anthropic_tools:
            kwargs["tools"] = anthropic_tools
        if os.getenv("AUTOCODE_ENABLE_THINKING", "false").lower() in ("1", "true", "yes", "on"):
            thinking_budget = int(os.getenv("AUTOCODE_THINKING_BUDGET", "8192") or "8192")
            max_out = int(kwargs.get("max_tokens") or self.max_tokens or 8192)
            kwargs["thinking"] = {
                "type": "enabled",
                "budget_tokens": min(thinking_budget, max(1024, max_out - 1024)),
            }

        logger.info(f"[LLM-Anthropic] → {self.model} msgs={len(messages)} tools={len(tools or [])}")

        response = await client.messages.create(**kwargs)

        # 解析 Anthropic 响应
        content = ""
        reasoning_content = ""
        tool_calls = []

        for block in response.content:
            if block.type == "text":
                content += block.text
            elif block.type == "thinking":
                reasoning_content += getattr(block, "thinking", "") or ""
            elif block.type == "tool_use":
                tool_calls.append(ToolCall(
                    id=block.id,
                    name=block.name,
                    arguments=block.input,
                ))

        logger.info(
            f"[LLM-Anthropic] ← {self.model} "
            f"finish={response.stop_reason} content_len={len(content)} "
            f"tool_calls={len(tool_calls)}"
        )

        if not content.strip() and not tool_calls:
            logger.warning(
                "[LLM-Anthropic] empty assistant message: "
                f"model={self.model} stop_reason={response.stop_reason} "
                f"reasoning_len={len(reasoning_content)}"
            )
            raise RuntimeError(
                f"LLM returned empty assistant message: model={self.model}, "
                f"stop_reason={response.stop_reason}, reasoning_len={len(reasoning_content)}"
            )

        return LLMResponse(
            content=content,
            tool_calls=tool_calls,
            finish_reason=response.stop_reason or "stop",
            model=response.model,
            usage=(
                {"input_tokens": response.usage.input_tokens,
                 "output_tokens": response.usage.output_tokens}
                if hasattr(response, "usage") else {}
            ),
            reasoning_content=reasoning_content,
        )


# ─── 工厂函数 ────────────────────────────────────────────────────

def create_client_from_channel(
    channel: dict,  # { api_key, base_url, provider, models: [...], model: str }
    timeout: float = 180.0,
) -> LLMClient:
    """
    从渠道配置创建 LLMClient。

    自动判断 provider 类型：
    - provider 为 "Anthropic" 且 base_url 含 "anthropic" → 使用原生 Anthropic 协议
    - 其他 → 使用 OpenAI-compatible 协议
    """
    provider = channel.get("provider", "")
    base_url = channel.get("base_url", "")
    via_muhugochat = os.getenv("AUTOCODE_LLM_VIA_MUHUGOCHAT", "false").lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if via_muhugochat:
        internal_key = (
            os.getenv("MUHUGOCHAT_INTERNAL_API_KEY")
            or os.getenv("INTERNAL_API_KEY")
            or ""
        )
        internal_url = os.getenv("MUHUGOCHAT_API_URL", "http://127.0.0.1:8080/api/admin")
        if not internal_key:
            raise RuntimeError(
                "AUTOCODE_LLM_VIA_MUHUGOCHAT=true but MUHUGOCHAT_INTERNAL_API_KEY/INTERNAL_API_KEY is empty"
            )
        return LLMClient(
            api_key=internal_key,
            base_url=internal_url,
            model=channel["model"],
            provider="muhugochat-proxy",
            source_provider="muhugochat",
            channel_id=(
                str(channel.get("channel_id") or channel.get("uuid") or channel.get("id") or "")
                or None
            ),
            billing_model=str(channel.get("billing_model") or channel.get("platform_model") or channel.get("model") or ""),
            timeout=timeout,
        )

    # 判断是否为 Anthropic 原生
    is_anthropic = (
        provider.lower() == "anthropic"
        and base_url
        and ("anthropic" in base_url.lower())
    )

    return LLMClient(
        api_key=channel["api_key"],
        base_url=base_url,
        model=channel["model"],
        provider="anthropic" if is_anthropic else "openai-compat",
        source_provider=provider or ("anthropic" if is_anthropic else "openai-compat"),
        channel_id=(
            str(channel.get("channel_id") or channel.get("uuid") or channel.get("id") or "")
            or None
        ),
        billing_model=str(channel.get("billing_model") or channel.get("platform_model") or channel.get("model") or ""),
        timeout=timeout,
    )
