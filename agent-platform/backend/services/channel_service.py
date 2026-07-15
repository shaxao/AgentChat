# -*- coding: utf-8 -*-
"""
Channel Service — 从 MuhugoChat 获取 AI 渠道凭据。

数据源（按优先级）：
1. HTTP API（推荐，适用于本地开发环境，通过调用 MuhugoChat 的内部 API）
2. 直连 MySQL 数据库（适用于生产环境）

改造要点（借鉴 OpenCode Provider 抽象层）：
- 不再限制只查 Anthropic → 查询所有 active 渠道
- 支持 OpenAI、DeepSeek、Kimi、Qwen、Anthropic 等所有 OpenAI-compatible 提供商
- 同时查询 model_config 表，按 capabilities 标签筛选支持 tool calling 的模型
"""
import os
import json
import logging
import re
from typing import Optional, Union
from dataclasses import dataclass, field

import pymysql
from pymysql.cursors import DictCursor

import httpx

from core.config import settings

logger = logging.getLogger("autocode.channel")

# ── HTTP API 配置 ─────────────────────────────────────────
MUHUGOCHAT_API_URL = os.getenv("MUHUGOCHAT_API_URL", "http://localhost:8080/api/admin")
INTERNAL_API_KEY = (
    os.getenv("MUHUGOCHAT_INTERNAL_API_KEY")
    or os.getenv("INTERNAL_API_KEY")
    or ""
)
REQUIRE_CHANNEL_API = os.getenv("AUTOCODE_REQUIRE_CHANNEL_API", "true").lower() in (
    "1",
    "true",
    "yes",
    "on",
)


class ChannelBridgeError(RuntimeError):
    """Raised when the MuhugoChat internal model/channel bridge is broken."""
    pass

# ── MySQL 连接状态缓存 ─────────────────────────────────────────
_mysql_checked: bool = False
_api_mode: bool | None = None  # None=未检测, True=使用API, False=使用数据库


def _use_http_api() -> bool:
    """判断是否使用 HTTP API 模式（优先尝试 API，失败则回退到数据库）"""
    global _api_mode
    if _api_mode is not None:
        return _api_mode
    
    # 检查是否配置了 API URL 且可访问
    api_url = MUHUGOCHAT_API_URL.rstrip("/")
    try:
        resp = httpx.get(
            f"{api_url}/internal/channels",
            params={"apiKey": INTERNAL_API_KEY} if INTERNAL_API_KEY else {},
            headers={"X-Internal-Api-Key": INTERNAL_API_KEY} if INTERNAL_API_KEY else {},
            timeout=3
        )
        if resp.status_code == 200 and _api_result_ok(resp.json()):
            logger.info(f"[Channel] ✅ Using HTTP API mode: {api_url}")
            _api_mode = True
            return True
    except Exception as e:
        logger.debug(f"[Channel] HTTP API not available: {e}")
    
    logger.info("[Channel] Using database mode (HTTP API not available)")
    _api_mode = False
    return False


def _get_connection():
    """
    获取 MuhugoChat 数据库连接。
    连接失败时抛出清晰异常，并在首次失败时打印友好提示。
    """
    global _mysql_checked
    try:
        return pymysql.connect(
            host=settings.muhugochat_db_host,
            port=settings.muhugochat_db_port,
            user=settings.muhugochat_db_user,
            password=settings.muhugochat_db_password,
            database=settings.muhugochat_db_name,
            charset="utf8mb4",
            cursorclass=DictCursor,
            connect_timeout=5,
        )
    except Exception as e:
        if not _mysql_checked:
            logger.warning(
                f"[Channel] ❌ Cannot connect to MySQL at "
                f"{settings.muhugochat_db_host}:{settings.muhugochat_db_port}\n"
                f"  Error: {e}\n"
                f"  → LLM channel config will be unavailable.\n"
                f"  → Fix: update MUHUGOCHAT_DB_HOST in .env "
                f"(try 'localhost' if running outside Docker).\n"
                f"  → Or set API keys directly in .env "
                f"(ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, etc.)."
            )
            _mysql_checked = True
        raise


@dataclass
class ChannelConfig:
    """渠道配置"""
    id: int
    uuid: str
    name: str
    provider: str
    api_key: str
    base_url: str
    models: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    priority: int = 0


@dataclass
class ModelInfo:
    """模型信息（来自 model_config 表）"""
    id: int
    model_id: str
    name: str
    provider: str
    capabilities: list[str] = field(default_factory=list)
    input_price: float = 0.0
    output_price: float = 0.0
    context_length: int = 4096
    code_quality: int = 60
    strengths: list[str] = field(default_factory=list)


def _parse_json_array(raw: str | None) -> list[str]:
    """解析 JSON 数组字段（如 models, tags）"""
    if not raw:
        return []
    try:
        arr = json.loads(raw)
        if isinstance(arr, list):
            return [str(x) for x in arr if x]
        # 可能是逗号分隔字符串
        return [x.strip() for x in raw.split(",") if x.strip()]
    except (json.JSONDecodeError, TypeError):
        # 回退：逗号分隔字符串
        return [x.strip() for x in raw.split(",") if x.strip()]


def _parse_json_array(raw: str | None) -> list[str]:
    """Parse a JSON array or comma-separated string field."""
    if not raw:
        return []
    try:
        arr = json.loads(raw)
        if isinstance(arr, list):
            return [str(x).strip() for x in arr if str(x).strip()]
    except (json.JSONDecodeError, TypeError):
        pass
    return [x.strip() for x in str(raw).split(",") if x.strip()]


def _api_result_ok(payload: dict) -> bool:
    """Accept both legacy {success:true} and Java Result {code:200,message:'success'}."""
    if not isinstance(payload, dict):
        return False
    if payload.get("success") is True:
        return True
    code = payload.get("code")
    if code in (0, 200, "0", "200"):
        return True
    message = str(payload.get("message") or "").strip().lower()
    return message in ("success", "ok")


def _api_result_data(payload: dict):
    if isinstance(payload, dict) and "data" in payload:
        return payload.get("data")
    return []


def _first_present(item: dict, *keys: str, default=None):
    for key in keys:
        value = item.get(key)
        if value is not None:
            return value
    return default


def _is_active_status(status) -> bool:
    if status is None:
        return True
    text = str(status).strip().lower()
    return text in ("active", "enabled", "enable", "1", "true")


def _strip_version_suffix(model_id: str) -> str:
    text = (model_id or "").strip()
    if not text:
        return ""
    # deepseek-v4-flash-260425 -> deepseek-v4-flash
    return re.sub(r"[-_](20\d{4}|\d{6,})$", "", text, flags=re.I)


def _choose_channel_api_model(ch: ChannelConfig, platform_model_id: str) -> str:
    models = [m for m in (ch.models or []) if str(m).strip()]
    if not models:
        return platform_model_id
    requested = (platform_model_id or "").strip().lower()
    for m in models:
        if str(m).strip().lower() == requested:
            return m

    base = _strip_version_suffix(platform_model_id).lower()
    if base:
        for m in models:
            if str(m).strip().lower() == base:
                return m
        for m in models:
            m_norm = str(m).strip().lower()
            if base in m_norm or m_norm in base:
                return m

    if len(models) == 1:
        return models[0]
    return platform_model_id


def fetch_all_channels() -> list[ChannelConfig]:
    """
    查询所有活跃渠道（不限 provider）。
    
    优先级：
    1. HTTP API 模式（本地开发环境，通过调用 MuhugoChat 的内部 API）
    2. 直连数据库模式（生产环境）

    Returns:
        按 priority DESC 排序的渠道列表
    """
    # 策略 1: HTTP API 模式
    if _use_http_api():
        return _fetch_channels_via_api()
    
    # 策略 2: 直连数据库模式
    try:
        conn = _get_connection()
    except Exception as e:
        logger.warning(f"[Channel] 无法连接 MuhugoChat 数据库: {e}")
        return []

    try:
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT id, uuid, name, provider, api_key, base_url,
                       models, tags, priority
                FROM model_channel
                WHERE status = 'active'
                  AND deleted = 0
                  AND api_key IS NOT NULL
                  AND api_key != ''
                ORDER BY priority DESC, id ASC
            """)
            rows = cursor.fetchall()

            channels = []
            for row in rows:
                channels.append(ChannelConfig(
                    id=row["id"],
                    uuid=row.get("uuid") or str(row["id"]),
                    name=row["name"] or row["provider"],
                    provider=row["provider"] or "unknown",
                    api_key=row["api_key"],
                    base_url=row.get("base_url") or "",
                    models=_parse_json_array(row.get("models")),
                    tags=_parse_json_array(row.get("tags")),
                    priority=row.get("priority") or 0,
                ))

            logger.info(f"[Channel] 加载了 {len(channels)} 个活跃渠道（数据库模式）")
            for ch in channels:
                logger.info(f"  - {ch.provider}/{ch.name}: {len(ch.models)} models, tags={ch.tags}")
            return channels

    except Exception as e:
        logger.error(f"[Channel] 查询渠道失败: {e}")
        return []
    finally:
        conn.close()


def _fetch_channels_via_api() -> list[ChannelConfig]:
    """通过 HTTP API 获取渠道配置"""
    api_url = MUHUGOCHAT_API_URL.rstrip("/")
    try:
        resp = httpx.get(
            f"{api_url}/internal/channels",
            params={"apiKey": INTERNAL_API_KEY} if INTERNAL_API_KEY else {},
            headers={"X-Internal-Api-Key": INTERNAL_API_KEY} if INTERNAL_API_KEY else {},
            timeout=5
        )
        resp.raise_for_status()
        data = resp.json()
        
        # 检查返回格式（Result.ok() 返回 { success: true, data: [...] }）
        if not _api_result_ok(data):
            logger.error(f"[Channel] API returned error: {data.get('message')}")
            return []
        
        channels = []
        for item in _api_result_data(data) or []:
            api_key = _first_present(item, "apiKey", "api_key")
            if not _is_active_status(item.get("status")) or not api_key:
                continue
            
            channels.append(ChannelConfig(
                id=item["id"],
                uuid=item.get("uuid") or str(item["id"]),
                name=_first_present(item, "name", default="") or _first_present(item, "provider", default="unknown"),
                provider=_first_present(item, "provider", default="unknown") or "unknown",
                api_key=api_key,
                base_url=_first_present(item, "baseUrl", "base_url", default="") or "",
                models=_parse_json_array(_first_present(item, "models", default="")),
                tags=_parse_json_array(_first_present(item, "tags", default="")),
                priority=item.get("priority") or 0,
            ))
        
        logger.info(f"[Channel] 加载了 {len(channels)} 个活跃渠道（API 模式）")
        for ch in channels:
            logger.info(f"  - {ch.provider}/{ch.name}: {len(ch.models)} models, tags={ch.tags}")
        return channels
        
    except Exception as e:
        logger.error(f"[Channel] HTTP API 获取渠道失败: {e}")
        return []


def fetch_models_with_capability(
    capability: str = "tool",
    min_context_length: int = 4096,
) -> list[ModelInfo]:
    """
    查询具备特定能力的模型（来自 model_config 表）。

    Args:
        capability: 能力标签（如 "tool", "vision"）
        min_context_length: 最低上下文长度要求

    Returns:
        符合条件且已启用的模型列表
    """
    # 策略 1: HTTP API 模式
    if _use_http_api():
        return _fetch_models_via_api(capability, min_context_length)
    
    # 策略 2: 直连数据库模式
    try:
        conn = _get_connection()
    except Exception as e:
        logger.warning(f"[Model] 无法连接数据库: {e}")
        return []

    try:
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT id, model_id, name, provider, capabilities,
                       input_price, output_price, context_length,
                       code_quality, strengths
                FROM model_config
                WHERE enabled = 1
                  AND deleted = 0
                  AND capabilities IS NOT NULL
                  AND capabilities != ''
                ORDER BY input_price ASC, id ASC
            """)
            rows = cursor.fetchall()

            models = []
            for row in rows:
                caps_raw = row.get("capabilities", "")
                caps = [c.strip() for c in caps_raw.split(",") if c.strip()]

                # 能力过滤
                if capability and capability not in caps:
                    continue

                ctx_len = row.get("context_length") or 0
                if min_context_length > 0 and ctx_len < min_context_length:
                    continue

                # 解析 strengths (JSON 或逗号分隔)
                strengths_raw = row.get("strengths")
                strengths = _parse_json_array(strengths_raw) if strengths_raw else []

                models.append(ModelInfo(
                    id=row["id"],
                    model_id=row["model_id"],
                    name=row["name"] or row["model_id"],
                    provider=row["provider"] or "",
                    capabilities=caps,
                    input_price=float(row.get("input_price") or 0),
                    output_price=float(row.get("output_price") or 0),
                    context_length=ctx_len,
                    code_quality=int(row.get("code_quality") or 60),
                    strengths=strengths,
                ))

            logger.info(f"[Model] 具备 '{capability}' 能力的模型: {len(models)} 个（数据库模式）")
            return models

    except Exception as e:
        logger.error(f"[Model] 查询 model_config 失败: {e}")
        return []
    finally:
        conn.close()


def _fetch_models_via_api(capability: str, min_context_length: int) -> list[ModelInfo]:
    """通过 HTTP API 获取模型配置"""
    api_url = MUHUGOCHAT_API_URL.rstrip("/")
    try:
        resp = httpx.get(
            f"{api_url}/internal/models",
            params={"apiKey": INTERNAL_API_KEY} if INTERNAL_API_KEY else {},
            headers={"X-Internal-Api-Key": INTERNAL_API_KEY} if INTERNAL_API_KEY else {},
            timeout=5
        )
        resp.raise_for_status()
        data = resp.json()
        
        if not _api_result_ok(data):
            logger.error(f"[Model] API returned error: {data.get('message')}")
            return []
        
        models = []
        for item in _api_result_data(data) or []:
            if str(_first_present(item, "enabled", default="true")).lower() in ("false", "0"):
                continue
            
            caps_raw = _first_present(item, "capabilities", default="")
            # 处理 capabilities 字段（可能是字符串或列表）
            if isinstance(caps_raw, list):
                caps = [c.strip() for c in caps_raw if c.strip()]
            elif isinstance(caps_raw, str):
                caps = [c.strip() for c in caps_raw.split(",") if c.strip()]
            else:
                caps = []
            
            # 能力过滤
            if capability and capability not in caps:
                continue
            
            ctx_len = _first_present(item, "contextLength", "context_length", default=0) or 0
            if min_context_length > 0 and ctx_len < min_context_length:
                continue
            
            strengths_raw = _first_present(item, "strengths", default="")
            if isinstance(strengths_raw, list):
                strengths = [str(s).strip() for s in strengths_raw if s]
            elif isinstance(strengths_raw, str):
                strengths = [s.strip() for s in strengths_raw.split(",") if s.strip()]
            else:
                strengths = []

            models.append(ModelInfo(
                id=item["id"],
                model_id=_first_present(item, "modelId", "model_id", default=""),
                name=_first_present(item, "name", default="") or _first_present(item, "modelId", "model_id", default=""),
                provider=_first_present(item, "provider", default="") or "",
                capabilities=caps,
                input_price=float(_first_present(item, "inputPrice", "input_price", default=0) or 0),
                output_price=float(_first_present(item, "outputPrice", "output_price", default=0) or 0),
                context_length=ctx_len,
                code_quality=int(_first_present(item, "codeQuality", "code_quality", default=60) or 60),
                strengths=strengths,
            ))
        
        logger.info(f"[Model] 具备 '{capability}' 能力的模型: {len(models)} 个（API 模式）")
        return models
        
    except Exception as e:
        logger.error(f"[Model] HTTP API 获取模型失败: {e}")
        return []


def resolve_channel_for_model(
    model_id: str,
    channels: list[ChannelConfig] | None = None,
) -> Optional[tuple[ChannelConfig, str]]:
    """
    根据 model_id 查找它所属的渠道。

    匹配规则（按优先级）：
    1. 渠道 models 字段精确包含 model_id
    2. 渠道 models 字段模糊匹配（model_id 包含在 model 名中）
    3. 渠道 provider 名匹配 model_id 前缀

    Returns:
        (ChannelConfig, model_id) 或 None
    """
    if channels is None:
        channels = fetch_all_channels()

    model_id_norm = (model_id or "").strip().lower()
    provider_hint = ""
    try:
        for model_info in fetch_models_with_capability("", 0):
            if (model_info.model_id or "").strip().lower() == model_id_norm:
                provider_hint = (model_info.provider or "").strip().lower()
                break
    except Exception:
        provider_hint = ""

    for ch in channels:
        if not ch.models:
            continue
        # 精确匹配
        for m in ch.models:
            if (m or "").strip().lower() == model_id_norm:
                return (ch, m)

    # Prefer the provider configured in model_config. Do not infer provider from
    # model_id text; versioned aliases may intentionally route to another vendor.
    if provider_hint:
        for ch in channels:
            provider = (ch.provider or "").strip().lower()
            name = (ch.name or "").strip().lower()
            if (
                provider == provider_hint
                or name == provider_hint
                or provider_hint in provider
                or provider_hint in name
            ):
                logger.info(
                    f"[Resolve] provider hint matched: model={model_id} "
                    f"provider_hint={provider_hint} channel={ch.provider}/{ch.name}"
                )
                return (ch, _choose_channel_api_model(ch, model_id))

    # Fuzzy fallback only when requested id is shorter than a concrete channel
    # model. Never map a longer versioned id to a shorter base model.
    for ch in channels:
        if not ch.models:
            continue
        for m in ch.models:
            m_norm = (m or "").strip().lower()
            if model_id_norm and model_id_norm in m_norm:
                return (ch, m)

    return None


def select_best_tool_model(channels: list[ChannelConfig] | None = None) -> Optional[tuple[ChannelConfig, str]]:
    """
    选择最佳的具备 tool calling 能力的模型。

    策略（借鉴 OpenCode 成本感知模型选择）：
    1. 从 model_config 表查找具备 "tool" 能力的模型（按价格排序）
    2. 找到这些模型所属的渠道
    3. 优先选择价格最低的可用模型
    4. 回退到渠道 tags 包含 "tool" 的渠道（兼容未配置 model_config 的场景）

    Returns:
        (ChannelConfig, model_name) 或 None
    """
    if channels is None:
        channels = fetch_all_channels()

    if not channels:
        logger.error("[Select] 无活跃渠道")
        return None

    # 策略 1：从 model_config 表选择最便宜的 tool 模型
    tool_models = fetch_models_with_capability("tool")
    for model_info in tool_models:
        result = resolve_channel_for_model(model_info.model_id, channels)
        if result:
            ch, model_name = result
            logger.info(
                f"[Select] 选择 tool 模型: {model_name} "
                f"via {ch.provider}/{ch.name} (¥{model_info.input_price}/1K tokens)"
            )
            return (ch, model_name)

    # 策略 2：回退 — 查找 tags 包含 "tool" 的渠道
    for ch in channels:
        if "tool" in ch.tags and ch.models:
            model = ch.models[0]  # 用第一个模型
            logger.info(f"[Select] 回退选择: {model} via {ch.provider}/{ch.name} (by channel tags)")
            return (ch, model)

    # 策略 3：最终回退 — 使用第一个有模型的渠道
    for ch in channels:
        if ch.models:
            model = ch.models[0]
            logger.warning(f"[Select] 最终回退: {model} via {ch.provider}/{ch.name} (may not support tools)")
            return (ch, model)

    logger.error("[Select] 未找到可用模型")
    return None


# ── 向后兼容接口 ──────────────────────────────────────────────────

def _fetch_internal_payload(endpoint: str, label: str, timeout: float = 5) -> dict:
    """Fetch a MuhugoChat internal API payload and fail loudly on bridge issues."""
    api_url = MUHUGOCHAT_API_URL.rstrip("/")
    url = f"{api_url}/internal/{endpoint}"
    headers = {"X-Internal-Api-Key": INTERNAL_API_KEY} if INTERNAL_API_KEY else {}
    params = {"apiKey": INTERNAL_API_KEY} if INTERNAL_API_KEY else {}
    try:
        resp = httpx.get(url, params=params, headers=headers, timeout=timeout)
    except Exception as exc:
        raise ChannelBridgeError(
            f"{label} request failed: url={url}, key_set={bool(INTERNAL_API_KEY)}, error={exc}"
        ) from exc

    body_excerpt = resp.text[:300].replace("\n", " ")
    if resp.status_code in (401, 403):
        raise ChannelBridgeError(
            f"{label} unauthorized: status={resp.status_code}, url={url}, "
            f"key_set={bool(INTERNAL_API_KEY)}, body={body_excerpt}. "
            "Java INTERNAL_API_KEY and AutoCode MUHUGOCHAT_INTERNAL_API_KEY are likely out of sync."
        )
    if resp.status_code >= 400:
        raise ChannelBridgeError(
            f"{label} failed: status={resp.status_code}, url={url}, body={body_excerpt}"
        )

    try:
        payload = resp.json()
    except Exception as exc:
        raise ChannelBridgeError(
            f"{label} returned non-JSON response: url={url}, body={body_excerpt}"
        ) from exc

    if not _api_result_ok(payload):
        raise ChannelBridgeError(
            f"{label} returned error: url={url}, message={payload.get('message')}, body={body_excerpt}"
        )
    return payload


def _use_http_api() -> bool:
    """Strict HTTP bridge mode by default; optional DB fallback for local dev."""
    global _api_mode
    if _api_mode is not None:
        return _api_mode

    try:
        _fetch_internal_payload("channels", "channel bridge probe", timeout=3)
        _api_mode = True
        logger.info("[Channel] Using HTTP API mode: %s", MUHUGOCHAT_API_URL.rstrip("/"))
        return True
    except ChannelBridgeError:
        if REQUIRE_CHANNEL_API:
            raise
        logger.warning("[Channel] HTTP API unavailable; falling back to DB because AUTOCODE_REQUIRE_CHANNEL_API=false")
        _api_mode = False
        return False


def _fetch_channels_via_api() -> list[ChannelConfig]:
    """Fetch active model channels from MuhugoChat internal API."""
    data = _fetch_internal_payload("channels", "channel list")
    channels: list[ChannelConfig] = []
    skipped_without_key = 0
    skipped_without_models = 0

    for item in _api_result_data(data) or []:
        api_key = _first_present(item, "apiKey", "api_key")
        models = _parse_json_array(_first_present(item, "models", default=""))
        if not _is_active_status(item.get("status")):
            continue
        if not api_key:
            skipped_without_key += 1
            continue
        if not models:
            skipped_without_models += 1
            continue

        channels.append(ChannelConfig(
            id=item["id"],
            uuid=item.get("uuid") or str(item["id"]),
            name=_first_present(item, "name", default="") or _first_present(item, "provider", default="unknown"),
            provider=_first_present(item, "provider", default="unknown") or "unknown",
            api_key=api_key,
            base_url=_first_present(item, "baseUrl", "base_url", default="") or "",
            models=models,
            tags=_parse_json_array(_first_present(item, "tags", default="")),
            priority=item.get("priority") or 0,
        ))

    if not channels:
        raise ChannelBridgeError(
            "MuhugoChat internal channel API returned no usable active channels. "
            f"skipped_without_key={skipped_without_key}, skipped_without_models={skipped_without_models}. "
            "Check admin model channels: status=active, apiKey present, models configured."
        )

    logger.info("[Channel] Loaded %s active channels via API", len(channels))
    for ch in channels:
        logger.info("[Channel] channel=%s/%s models=%s tags=%s", ch.provider, ch.name, len(ch.models), ch.tags)
    return channels


def _fetch_models_via_api(capability: str, min_context_length: int) -> list[ModelInfo]:
    """Fetch model metadata from MuhugoChat internal API."""
    data = _fetch_internal_payload("models", "model list")
    raw_items = _api_result_data(data) or []
    if not raw_items:
        raise ChannelBridgeError("MuhugoChat internal model API returned empty data.")

    models: list[ModelInfo] = []
    for item in raw_items:
        if str(_first_present(item, "enabled", default="true")).lower() in ("false", "0"):
            continue

        caps_raw = _first_present(item, "capabilities", default="")
        if isinstance(caps_raw, list):
            caps = [str(c).strip() for c in caps_raw if str(c).strip()]
        else:
            caps = [c.strip() for c in str(caps_raw or "").split(",") if c.strip()]
        if capability and capability not in caps:
            continue

        ctx_len = _first_present(item, "contextLength", "context_length", default=0) or 0
        if min_context_length > 0 and ctx_len < min_context_length:
            continue

        strengths_raw = _first_present(item, "strengths", default="")
        strengths = _parse_json_array(strengths_raw) if isinstance(strengths_raw, str) else [
            str(s).strip() for s in (strengths_raw or []) if str(s).strip()
        ]
        model_id = _first_present(item, "modelId", "model_id", default="")
        if not model_id:
            continue

        models.append(ModelInfo(
            id=item["id"],
            model_id=model_id,
            name=_first_present(item, "name", default="") or model_id,
            provider=_first_present(item, "provider", default="") or "",
            capabilities=caps,
            input_price=float(_first_present(item, "inputPrice", "input_price", default=0) or 0),
            output_price=float(_first_present(item, "outputPrice", "output_price", default=0) or 0),
            context_length=ctx_len,
            code_quality=int(_first_present(item, "codeQuality", "code_quality", default=60) or 60),
            strengths=strengths,
        ))

    logger.info("[Model] Loaded %s models via API for capability=%s", len(models), capability or "*")
    return models


def get_anthropic_config() -> dict:
    """
    [向后兼容] 仅查询 Anthropic 渠道。

    Returns:
        { "api_key": str, "base_url": str|None, "models": list[str] }
    """
    channels = fetch_all_channels()
    for ch in channels:
        if ch.provider.lower() in ("anthropic", "claude") or "claude" in ch.name.lower():
            return {
                "api_key": ch.api_key,
                "base_url": ch.base_url or None,
                "models": ch.models,
            }

    # 回退到环境变量
    env_key = settings.anthropic_api_key
    env_url = os.getenv("ANTHROPIC_BASE_URL", "")
    if env_key:
        logger.info("[Channel] 使用 ANTHROPIC_API_KEY 环境变量")
        return {"api_key": env_key, "base_url": env_url or None, "models": []}

    return {"api_key": "", "base_url": None, "models": []}


def get_anthropic_config() -> dict:
    """Backward-compatible Anthropic channel lookup."""
    channels = fetch_all_channels()
    for ch in channels:
        if ch.provider.lower() in ("anthropic", "claude") or "claude" in ch.name.lower():
            return {
                "api_key": ch.api_key,
                "base_url": ch.base_url or None,
                "models": ch.models,
            }

    env_key = settings.anthropic_api_key
    env_url = os.getenv("ANTHROPIC_BASE_URL", "")
    if env_key:
        logger.info("[Channel] Using ANTHROPIC_API_KEY environment variable")
        return {"api_key": env_key, "base_url": env_url or None, "models": []}

    return {"api_key": "", "base_url": None, "models": []}
