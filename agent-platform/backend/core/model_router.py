# -*- coding: utf-8 -*-
"""
智能模型路由器 — 多维度评分 + 场景路由 + 熔断降级

核心设计：
- 四维度加权评分（能力匹配 40% + 场景亲和 25% + 成本效率 20% + 可用性 15%）
- TaskContext 路由信号驱动模型选择
- 路由规则表 (autocode_model_routing) 实现场景→模型映射
- FailoverLLMClient 自动故障转移（最多 3 个候选）
- FailureTracker 熔断器（5min 内 3 次失败 → 降级，10min 后恢复探测）
"""
import asyncio
import json
import time
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

import pymysql
from pymysql.cursors import DictCursor

from core.config import settings
from core.llm_client import LLMClient, LLMResponse, ToolDefinition, create_client_from_channel

logger = logging.getLogger("autocode.router")


# ═══════════════════════════════════════════════════════════════
# 数据结构
# ═══════════════════════════════════════════════════════════════

@dataclass
class TaskContext:
    """任务上下文 — 路由器的输入信号"""
    agent_type: str = ""          # frontend | backend | devops | researcher
    task_phase: str = "implementation"  # planning | implementation | debugging | review | deployment
    content_types: list[str] = field(default_factory=lambda: ["code"])
    complexity: str = "moderate"   # simple | moderate | complex
    required_capabilities: list[str] = field(default_factory=lambda: ["tool"])


@dataclass
class ModelCandidate:
    """候选模型 — 带评分和元数据"""
    model_id: str
    api_model: str = ""
    name: str = ""
    provider: str = ""
    api_key: str = ""
    base_url: str = ""
    capabilities: list[str] = field(default_factory=list)
    strengths: list[str] = field(default_factory=list)
    code_quality: int = 60
    input_price: float = 0.0
    output_price: float = 0.0
    context_length: int = 4096

    # 路由计算字段
    score: float = 0.0
    weight_bonus: float = 0.0
    failover_order: int = 0
    priority: int = 100

    # 评分明细（调试用）
    score_detail: dict = field(default_factory=dict)

    def to_channel_config(self) -> dict:
        return {
            "api_key": self.api_key,
            "base_url": self.base_url,
            "provider": self.provider,
            "model": self.api_model or self.model_id,
            "billing_model": self.model_id,
            "name": self.name,
        }


# ═══════════════════════════════════════════════════════════════
# 熔断器
# ═══════════════════════════════════════════════════════════════

class FailureTracker:
    """
    模型级别的熔断器。
    - 跟踪每个模型的连续失败次数
    - 5 分钟内连续失败 3 次 → 熔断（自动降级）
    - 10 分钟后自动恢复探测
    """

    CIRCUIT_BREAK_THRESHOLD = 3      # 连续失败次数阈值
    CIRCUIT_BREAK_WINDOW = 300       # 失败窗口（秒）= 5 分钟
    CIRCUIT_RECOVERY_TIME = 600      # 恢复时间（秒）= 10 分钟

    def __init__(self):
        self._failures: dict[str, list[float]] = defaultdict(list)  # model_id → [timestamps]
        self._circuit_open_until: dict[str, float] = {}            # model_id → 熔断截止时间

    def record_failure(self, model_id: str):
        """记录一次失败"""
        now = time.time()
        self._failures[model_id].append(now)
        # 清理过期记录
        self._failures[model_id] = [
            t for t in self._failures[model_id]
            if now - t < self.CIRCUIT_BREAK_WINDOW
        ]
        # 检查是否需要熔断
        if len(self._failures[model_id]) >= self.CIRCUIT_BREAK_THRESHOLD:
            self._circuit_open_until[model_id] = now + self.CIRCUIT_RECOVERY_TIME
            logger.warning(
                f"[FailureTracker] 🔴 熔断触发: {model_id} "
                f"({len(self._failures[model_id])} 次失败/5min)，"
                f"恢复时间: {self.CIRCUIT_RECOVERY_TIME}秒后"
            )

    def record_success(self, model_id: str):
        """记录一次成功 → 重置熔断"""
        if model_id in self._failures:
            del self._failures[model_id]
        if model_id in self._circuit_open_until:
            del self._circuit_open_until[model_id]
            logger.info(f"[FailureTracker] 🟢 熔断恢复: {model_id} (调用成功)")

    def is_available(self, model_id: str) -> bool:
        """检查模型当前是否可用（未被熔断）"""
        until = self._circuit_open_until.get(model_id)
        if until is None:
            return True
        if time.time() >= until:
            # 熔断时间已过，允许恢复探测
            del self._circuit_open_until[model_id]
            self._failures.pop(model_id, None)
            logger.info(f"[FailureTracker] 🟡 恢复探测: {model_id} (熔断时间已过)")
            return True
        return False

    def get_stats(self) -> dict:
        """获取熔断统计（供 API 暴露）"""
        now = time.time()
        return {
            "circuit_broken": {
                mid: round(until - now, 1)
                for mid, until in self._circuit_open_until.items()
                if until > now
            },
            "failure_counts": {
                mid: len(timestamps)
                for mid, timestamps in self._failures.items()
            },
        }

    def force_reset(self, model_id: str = None):
        """强制重置熔断状态"""
        if model_id:
            self._failures.pop(model_id, None)
            self._circuit_open_until.pop(model_id, None)
        else:
            self._failures.clear()
            self._circuit_open_until.clear()


# 全局熔断器单例
failure_tracker = FailureTracker()


# ═══════════════════════════════════════════════════════════════
# 模型路由器
# ═══════════════════════════════════════════════════════════════

class ModelRouter:
    """
    智能模型路由器。

    用法:
        router = ModelRouter()
        candidates = await router.select(TaskContext(agent_type="frontend", complexity="complex"))
        best = candidates[0]  # 评分最高的模型
    """

    # 领域→所需能力映射
    CAPABILITY_MAP = {
        "frontend":  ["tool", "code"],
        "backend":   ["tool", "code", "reasoning"],
        "devops":    ["tool"],
        "researcher": ["tool", "reasoning"],
    }

    # 场景→模型优势偏好映射
    STRENGTH_PREFERENCE = {
        ("frontend", "implementation"):  ["frontend", "code_generation"],
        ("frontend", "debugging"):       ["debugging", "frontend"],
        ("frontend", "planning"):        ["planning", "frontend"],
        ("backend", "implementation"):   ["backend", "code_generation"],
        ("backend", "debugging"):        ["debugging", "backend"],
        ("backend", "planning"):         ["planning", "reasoning"],
        ("devops", "*"):                 ["devops"],
        ("researcher", "*"):             ["reasoning", "research"],
    }

    # 复杂度→最低代码质量要求
    COMPLEXITY_QUALITY_THRESHOLD = {
        "simple":   50,
        "moderate": 65,
        "complex":  75,
    }

    def __init__(self):
        self._routing_cache = {}  # (agent_type, phase, content, complexity) → rules
        self._cache_ttl = 300     # 5分钟缓存

    # ── 主入口 ────────────────────────────────────────────────

    async def select(self, ctx: TaskContext) -> list[ModelCandidate]:
        """
        根据任务上下文选择最佳模型候选列表。

        Returns:
            按评分降序排列的候选模型列表。评分最高的排第一。
        """
        # 1. 获取所有可用候选模型
        all_candidates = await self._fetch_all_candidates()

        if not all_candidates:
            raise RuntimeError("未找到可用的模型！请检查 model_channel 和 model_config 配置。")

        # 2. 能力过滤
        candidates = self._filter_by_capabilities(all_candidates, ctx)

        # 3. 复杂度过滤（代码质量门槛）
        candidates = self._filter_by_complexity(candidates, ctx)

        if not candidates:
            logger.warning(f"[ModelRouter] 严格过滤后无候选，放宽条件重试")
            candidates = self._filter_by_capabilities(all_candidates, ctx, strict=False)
        elif len(candidates) < 3:
            relaxed = self._filter_by_capabilities(all_candidates, ctx, strict=False)
            existing = {c.model_id for c in candidates}
            for c in relaxed:
                if c.model_id not in existing:
                    candidates.append(c)
                    existing.add(c.model_id)
                if len(candidates) >= 3:
                    break

        # 4. 熔断过滤
        candidates = self._filter_circuit_broken(candidates)

        if not candidates:
            logger.warning(f"[ModelRouter] 所有模型被熔断！临时全部恢复")
            failure_tracker.force_reset()
            candidates = self._filter_by_capabilities(all_candidates, ctx, strict=False)

        # 5. 应用路由规则（权重加成）
        rules = await self._load_routing_rules(ctx)
        candidates = self._apply_routing_rules(candidates, rules)

        # 6. 四维度评分
        for c in candidates:
            c.score, c.score_detail = self._compute_score(c, ctx)

        # 7. 排序
        candidates.sort(key=lambda c: c.score, reverse=True)

        # 8. 日志
        for i, c in enumerate(candidates[:5]):
            logger.info(
                f"[ModelRouter] #{i+1} {c.model_id} "
                f"score={c.score:.3f} "
                f"cap={c.score_detail.get('capability',0):.2f} "
                f"aff={c.score_detail.get('affinity',0):.2f} "
                f"cost={c.score_detail.get('cost',0):.2f} "
                f"avail={c.score_detail.get('availability',0):.2f} "
                f"quality={c.code_quality}"
            )

        return candidates

    # ── 数据获取 ───────────────────────────────────────────────

    async def _fetch_all_candidates(self) -> list[ModelCandidate]:
        """从 MuhugoChat 数据库获取所有活跃的模型候选"""
        try:
            from services.channel_service import fetch_all_channels, fetch_models_with_capability, resolve_channel_for_model

            channels = fetch_all_channels()
            models = fetch_models_with_capability(min_context_length=0)

            # 构建渠道索引: model_id → channel_config
            channel_by_model: dict[str, dict] = {}
            for ch in channels:
                if not ch.models:
                    continue
                for m in ch.models:
                    channel_by_model[m] = {
                        "provider": ch.provider,
                        "api_key": ch.api_key,
                        "base_url": ch.base_url,
                        "api_model": m,
                    }

            # 构建候选列表
            candidates = []
            for mi in models:
                is_tool = "tool" in mi.capabilities
                is_code_fallback = any(cap in mi.capabilities for cap in ("code", "text"))

                # Prefer explicit tool-capable models, but keep code/text models as
                # low-priority failover candidates. Some OpenAI-compatible official
                # models support tools even when admin capability tags are incomplete.
                if not is_tool and not is_code_fallback:
                    continue

                ch_info = channel_by_model.get(mi.model_id) or channel_by_model.get(mi.name)
                api_model = mi.model_id
                resolved = resolve_channel_for_model(mi.model_id, channels)
                if resolved:
                    resolved_channel, api_model = resolved
                    ch_info = {
                        "provider": resolved_channel.provider,
                        "api_key": resolved_channel.api_key,
                        "base_url": resolved_channel.base_url,
                        "api_model": api_model,
                    }
                if not ch_info:
                    # 通过模糊匹配查找渠道
                    for m_key, ch_val in channel_by_model.items():
                        if mi.model_id in m_key or m_key in mi.model_id:
                            ch_info = ch_val
                            api_model = ch_val.get("api_model") or m_key
                            break

                if not ch_info:
                    logger.debug(f"[ModelRouter] 模型 {mi.model_id} 未匹配到渠道，跳过")
                    continue

                # 读取 code_quality 和 strengths（从 model_config 扩展字段）
                code_quality = mi.__dict__.get("code_quality", 60) or 60
                strengths_raw = mi.__dict__.get("strengths", None)
                strengths = self._parse_strengths(strengths_raw)
                capabilities = list(mi.capabilities)
                if not is_tool and is_code_fallback and "tool_fallback" not in capabilities:
                    capabilities.append("tool_fallback")

                candidates.append(ModelCandidate(
                    model_id=mi.model_id,
                    api_model=api_model,
                    name=mi.name or mi.model_id,
                    provider=ch_info["provider"],
                    api_key=ch_info["api_key"],
                    base_url=ch_info["base_url"],
                    capabilities=capabilities,
                    strengths=strengths,
                    code_quality=int(code_quality) - (15 if not is_tool else 0),
                    input_price=mi.input_price,
                    output_price=mi.output_price,
                    context_length=mi.context_length,
                ))

            logger.info(f"[ModelRouter] 载入 {len(candidates)} 个可用候选模型")
            return candidates

        except Exception as e:
            logger.error(f"[ModelRouter] 获取候选模型失败: {e}")
            raise

    # ── 过滤层 ─────────────────────────────────────────────────

    def _filter_by_capabilities(
        self, candidates: list[ModelCandidate], ctx: TaskContext, strict: bool = True,
    ) -> list[ModelCandidate]:
        """按 required_capabilities 过滤"""
        required = set(ctx.required_capabilities)
        if not required:
            return list(candidates)

        filtered = []
        for c in candidates:
            caps = set(c.capabilities)
            if strict:
                if required.issubset(caps):
                    filtered.append(c)
            else:
                # 宽松模式：tool 优先，允许 code/text 作为故障转移候选
                if "tool" in caps or "tool_fallback" in caps or "code" in caps or "text" in caps:
                    filtered.append(c)

        if len(filtered) < len(candidates):
            logger.info(
                f"[ModelRouter] 能力过滤: {len(candidates)} → {len(filtered)} "
                f"(required={required})"
            )
        return filtered

    def _filter_by_complexity(
        self, candidates: list[ModelCandidate], ctx: TaskContext,
    ) -> list[ModelCandidate]:
        """按复杂度过滤（代码质量门槛）"""
        threshold = self.COMPLEXITY_QUALITY_THRESHOLD.get(ctx.complexity, 50)
        filtered = [c for c in candidates if c.code_quality >= threshold]
        if len(filtered) < len(candidates):
            logger.info(
                f"[ModelRouter] 复杂度过滤 (threshold={threshold}): "
                f"{len(candidates)} → {len(filtered)}"
            )
        return filtered if filtered else candidates  # 降级：不过滤

    def _filter_circuit_broken(self, candidates: list[ModelCandidate]) -> list[ModelCandidate]:
        """过滤被熔断的模型"""
        filtered = [c for c in candidates if failure_tracker.is_available(c.model_id)]
        if len(filtered) < len(candidates):
            broken = [c.model_id for c in candidates if not failure_tracker.is_available(c.model_id)]
            logger.info(f"[ModelRouter] 熔断过滤: 移除 {broken}")
        return filtered

    # ── 路由规则 ───────────────────────────────────────────────

    async def _load_routing_rules(self, ctx: TaskContext) -> list[dict]:
        """从数据库中加载匹配的路由规则"""
        cache_key = (ctx.agent_type, ctx.task_phase,
                     ",".join(sorted(ctx.content_types)), ctx.complexity)
        now = time.time()

        # 检查缓存
        if cache_key in self._routing_cache:
            cached_time, rules = self._routing_cache[cache_key]
            if now - cached_time < self._cache_ttl:
                return rules

        try:
            rules = await self._query_routing_rules(ctx)
            self._routing_cache[cache_key] = (now, rules)
            return rules
        except Exception as e:
            logger.warning(f"[ModelRouter] 加载路由规则失败: {e}")
            return []

    async def _query_routing_rules(self, ctx: TaskContext) -> list[dict]:
        """查询数据库中的路由规则（在线程池中运行）"""
        import asyncio
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._query_routing_rules_sync, ctx)

    def _query_routing_rules_sync(self, ctx: TaskContext) -> list[dict]:
        """同步查询路由规则"""
        conn = None
        try:
            conn = pymysql.connect(
                host=settings.muhugochat_db_host,
                port=settings.muhugochat_db_port,
                user=settings.muhugochat_db_user,
                password=settings.muhugochat_db_password,
                database=settings.muhugochat_db_name,
                charset="utf8mb4",
                cursorclass=DictCursor,
                connect_timeout=5,
            )

            # 构建动态 SQL：匹配 agent_type、task_phase、content_type、complexity
            # 规则按 specificity（非 '*' 字段数）降序排列，越精确的规则越优先
            #
            # 扩展 content_types → 为每个类型独立查询（使用参数化查询防止 SQL 注入）
            if ctx.content_types:
                ct_placeholders = ",".join(["%s"] * len(ctx.content_types))
                ct_clause = f"AND (content_type IN ({ct_placeholders}) OR content_type = '*')"
                params = (ctx.agent_type, ctx.task_phase, *ctx.content_types, ctx.complexity)
            else:
                ct_clause = "AND content_type = '*'"
                params = (ctx.agent_type, ctx.task_phase, ctx.complexity)

            sql = f"""
                SELECT id, agent_type, task_phase, content_type, complexity,
                       model_id, priority, weight_bonus, failover_order
                FROM autocode_model_routing
                WHERE enabled = 1
                  AND (agent_type = %s OR agent_type = '*')
                  AND (task_phase = %s OR task_phase = '*')
                  {ct_clause}
                  AND (complexity = %s OR complexity = '*')
                ORDER BY
                    (CASE WHEN agent_type != '*' THEN 1 ELSE 0 END) +
                    (CASE WHEN task_phase != '*' THEN 1 ELSE 0 END) +
                    (CASE WHEN content_type != '*' THEN 1 ELSE 0 END) +
                    (CASE WHEN complexity != '*' THEN 1 ELSE 0 END) DESC,
                    priority DESC,
                    weight_bonus DESC
            """

            with conn.cursor() as cursor:
                cursor.execute(sql, params)
                rows = cursor.fetchall()
                rules = [dict(row) for row in rows]

            logger.debug(
                f"[ModelRouter] 加载 {len(rules)} 条路由规则 "
                f"(agent={ctx.agent_type}, phase={ctx.task_phase}, "
                f"complexity={ctx.complexity})"
            )
            return rules

        except Exception as e:
            logger.error(f"[ModelRouter] 查询路由规则失败: {e}")
            return []
        finally:
            if conn:
                conn.close()

    def _apply_routing_rules(
        self, candidates: list[ModelCandidate], rules: list[dict],
    ) -> list[ModelCandidate]:
        """应用路由规则：设置 weight_bonus、priority、failover_order"""
        if not rules:
            return candidates

        # 为每个模型找到最匹配的规则
        for c in candidates:
            matched = False
            for rule in rules:
                if rule["model_id"] == c.model_id:
                    c.weight_bonus = float(rule.get("weight_bonus", 0))
                    c.priority = rule.get("priority", 100)
                    c.failover_order = rule.get("failover_order", 0)
                    matched = True
                    break

            # 未匹配 → 使用默认值，failover_order 设高（优先级低）
            if not matched:
                c.weight_bonus = 0.0
                c.failover_order = 0

        # 按 failover_order 排序以设置故障转移链
        candidates.sort(key=lambda c: (c.failover_order if c.failover_order > 0 else 999))

        return candidates

    # ── 评分引擎 ───────────────────────────────────────────────

    def _compute_score(self, c: ModelCandidate, ctx: TaskContext) -> tuple[float, dict]:
        """
        四维度加权评分。

        - 能力匹配 (40%): 模型是否具备所需能力
        - 场景亲和 (25%): 模型擅长的领域是否匹配当前任务
        - 成本效率 (20%): 价格越低分数越高
        - 可用性 (15%): 模型质量评分 + 历史成功率
        """
        cap_score = self._score_capability(c, ctx)
        aff_score = self._score_affinity(c, ctx)
        cost_score = self._score_cost(c, ctx)
        avail_score = self._score_availability(c, ctx)

        total = (
            0.40 * cap_score +
            0.25 * aff_score +
            0.20 * cost_score +
            0.15 * avail_score
        )

        detail = {
            "capability": round(cap_score, 3),
            "affinity": round(aff_score, 3),
            "cost": round(cost_score, 3),
            "availability": round(avail_score, 3),
        }

        return round(total, 4), detail

    def _score_capability(self, c: ModelCandidate, ctx: TaskContext) -> float:
        """能力匹配评分 (0~1)"""
        required = ctx.required_capabilities
        if not required:
            return 0.8  # 无特别要求 → 默认高分

        caps = set(c.capabilities)
        required_set = set(required)

        # 交集数量 / 需求数量
        matched = len(required_set & caps)
        base = matched / len(required_set) if required_set else 1.0

        # 额外能力加成（有多余能力更好）
        extra = len(caps - required_set)
        bonus = min(extra * 0.05, 0.15)  # 每个额外能力 +0.05，最多 +0.15

        # 代码质量加权
        quality_boost = (c.code_quality / 100) * 0.1

        return min(base + bonus + quality_boost, 1.0)

    def _score_affinity(self, c: ModelCandidate, ctx: TaskContext) -> float:
        """场景亲和度评分 (0~1)"""
        # 确定偏好的 strengths
        preferred = self.STRENGTH_PREFERENCE.get(
            (ctx.agent_type, ctx.task_phase),
            self.STRENGTH_PREFERENCE.get((ctx.agent_type, "*"), []),
        )

        if not preferred:
            return 0.6  # 默认值

        model_strengths = set(c.strengths)
        preferred_set = set(preferred)

        # 匹配度
        matched = len(preferred_set & model_strengths)
        base = (matched / len(preferred_set)) if preferred_set else 0.5

        # weight_bonus 加成（来自路由规则）
        bonus = c.weight_bonus  # 0.00 ~ 1.00

        return min(base + bonus, 1.0)

    def _score_cost(self, c: ModelCandidate, ctx: TaskContext) -> float:
        """成本效率评分 (0~1) — 越便宜分数越高"""
        # 使用对数缩放来平滑价格差异
        # 免费模型 (0.0) 得满分
        max_price = 0.10  # ¥0.10/1K tokens 作为"昂贵"基准

        price = c.input_price
        if price <= 0:
            return 1.0

        if price >= max_price:
            return 0.1  # 最低分

        # 对数缩放：0.001 → 0.95, 0.01 → 0.75, 0.05 → 0.5, 0.10 → 0.1
        import math
        normalized = max(0.0, 1.0 - math.log10(price * 10 + 1) / math.log10(max_price * 10 + 1))
        return round(normalized, 3)

    def _score_availability(self, c: ModelCandidate, ctx: TaskContext) -> float:
        """可用性评分 (0~1) — 代码质量 + 熔断状态"""
        quality = c.code_quality / 100

        # 熔断惩罚
        circuit_penalty = 0.0
        if not failure_tracker.is_available(c.model_id):
            circuit_penalty = 0.5  # 熔断中 → 大幅降低

        # 失败计数惩罚
        fail_count = len(failure_tracker._failures.get(c.model_id, []))
        fail_penalty = min(fail_count * 0.1, 0.3)

        return max(0.0, quality - circuit_penalty - fail_penalty)

    # ── 辅助方法 ───────────────────────────────────────────────

    @staticmethod
    def _parse_strengths(raw) -> list[str]:
        """解析 strengths 字段（JSON 或逗号分隔字符串）"""
        if not raw:
            return []
        if isinstance(raw, list):
            return [str(s).strip() for s in raw if s]
        if isinstance(raw, str):
            try:
                arr = json.loads(raw)
                if isinstance(arr, list):
                    return [str(s).strip() for s in arr if s]
            except (json.JSONDecodeError, TypeError):
                pass
            return [s.strip() for s in raw.split(",") if s.strip()]
        return []

    @staticmethod
    def detect_complexity(description: str, agent_count: int = 1) -> str:
        """
        自动检测任务复杂度。

        关键词触发规则：
        - "简单"/"基础"/"静态"/"单页面" → simple
        - "复杂"/"完整"/"全栈"/"数据库"/"API"/"认证"/"支付" → complex
        - 3+ Agent 并行 → complex
        - 其他 → moderate
        """
        d = description.lower()

        # 简单模式关键词
        simple_kw = ["简单", "基础", "静态", "单页面", "单页", "demo", "示例",
                     "hello world", "static site", "simple", "basic", "minimal"]
        if any(kw in d for kw in simple_kw):
            return "simple"

        # 复杂模式关键词
        complex_kw = ["复杂", "完整", "全栈", "数据库", "orm", "认证", "支付",
                      "微服务", "分布式", "消息队列", "redis", "websocket",
                      "实时", "管理系统", "dashboard", "后台管理",
                      "fullstack", "full-stack", "enterprise", "complex",
                      "authentication", "payment", "microservice", "real-time",
                      "multi-page", "dashboard"]
        if any(kw in d for kw in complex_kw):
            return "complex"

        # 多 Agent 并行 → complex
        if agent_count >= 3:
            return "complex"

        return "moderate"


# ═══════════════════════════════════════════════════════════════
# 故障转移 LLM 客户端
# ═══════════════════════════════════════════════════════════════

class FailoverLLMClient:
    """
    带自动故障转移的 LLM 客户端包装器。

    用法:
        clients = [LLMClient(...) for c in candidates[:3]]
        fclient = FailoverLLMClient(clients)
        response = await fclient.chat(messages, tools)
        # 主模型失败自动切换到备选
    """

    def __init__(self, candidates: list[ModelCandidate], base_timeout: float = 180.0):
        self._candidates = candidates
        self._base_timeout = base_timeout
        self._clients: dict[str, LLMClient] = {}
        self._current_model: Optional[str] = None

    def _get_or_create_client(self, candidate: ModelCandidate) -> LLMClient:
        """懒加载创建 LLMClient"""
        if candidate.model_id not in self._clients:
            self._clients[candidate.model_id] = create_client_from_channel(
                candidate.to_channel_config(),
                timeout=self._base_timeout,
            )
        return self._clients[candidate.model_id]

    async def chat(
        self,
        messages: list[dict],
        tools: list[ToolDefinition] | None = None,
        system: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        max_retries: int = 3,
    ) -> LLMResponse:
        """
        发送对话请求，失败时自动切换到下一个候选模型。

        Args:
            max_retries: 最多尝试几个候选模型
        """
        last_error = None

        for i, candidate in enumerate(self._candidates[:max_retries]):
            if not failure_tracker.is_available(candidate.model_id):
                logger.warning(f"[Failover] 跳过熔断中的模型: {candidate.model_id}")
                continue

            try:
                client = self._get_or_create_client(candidate)
                logger.info(f"[Failover] 尝试 #{i+1}: {candidate.model_id} ({candidate.provider})")

                response = await client.chat(
                    messages=messages,
                    tools=tools,
                    system=system,
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
                if not response.content and not response.has_tool_calls:
                    raise RuntimeError(
                        f"empty assistant message from {candidate.model_id}: "
                        f"finish={response.finish_reason}, "
                        f"reasoning_len={len(response.reasoning_content or '')}"
                    )

                # 成功 → 记录
                failure_tracker.record_success(candidate.model_id)
                self._current_model = candidate.model_id
                logger.info(f"[Failover] ✅ 成功: {candidate.model_id}")
                return response

            except Exception as e:
                last_error = e
                failure_tracker.record_failure(candidate.model_id)
                logger.warning(
                    f"[Failover] ❌ #{i+1} {candidate.model_id} 失败: {e}，"
                    f"尝试下一个..."
                )

        # 全部失败
        error_msg = f"所有 {min(len(self._candidates), max_retries)} 个候选模型均调用失败！"
        if last_error:
            error_msg += f" 最后错误: {last_error}"
        raise RuntimeError(error_msg)

    @property
    def current_model(self) -> Optional[str]:
        return self._current_model


# ═══════════════════════════════════════════════════════════════
# 全局路由器单例
# ═══════════════════════════════════════════════════════════════

model_router = ModelRouter()
