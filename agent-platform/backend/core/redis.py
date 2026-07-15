# -*- coding: utf-8 -*-
"""Redis client singleton + pub/sub for SSE events."""
import json
import asyncio
from typing import Optional, Any
from loguru import logger
import redis.asyncio as redis
from core.config import settings
from core.state import _tasks

# Global singleton
_redis_client: Optional[redis.Redis] = None

# Event prefixes
EVENT_PREFIX_TASK = "autocode:task:"
EVENT_SUFFIX_EVENTS = ":events"

async def get_redis_client() -> Optional[redis.Redis]:
    """Get Redis client singleton (None if connection fails, gracefully degrade)."""
    global _redis_client
    if _redis_client is None:
        try:
            _redis_client = redis.from_url(settings.redis_dsn, decode_responses=True, socket_connect_timeout=3)
            await _redis_client.ping()
            logger.info("[Redis] Connected successfully")
        except Exception as e:
            logger.warning(f"[Redis] Connection failed: {e}, falling back to DB polling mode")
            _redis_client = None
    return _redis_client

async def publish_task_event(task_id: str, event_type: str, data: dict[str, Any]):
    """Publish a task event to Redis pub/sub channel (best-effort, no failure propagation)."""
    client = await get_redis_client()
    if not client:
        return
    try:
        payload = json.dumps({
            "type": event_type,
            "data": data,
            "timestamp": asyncio.get_event_loop().time()
        }, ensure_ascii=False)
        channel = f"{EVENT_PREFIX_TASK}{task_id}{EVENT_SUFFIX_EVENTS}"
        await client.publish(channel, payload)
    except Exception as e:
        logger.debug(f"[Redis] Publish failed: {e}")

async def subscribe_task_events(task_id: str, queue: asyncio.Queue):
    """Subscribe to task events and push to queue (run in background task)."""
    client = await get_redis_client()
    if not client:
        return
    try:
        channel = f"{EVENT_PREFIX_TASK}{task_id}{EVENT_SUFFIX_EVENTS}"
        async with client.pubsub() as pubsub:
            await pubsub.subscribe(channel)
            logger.debug(f"[Redis] Subscribed to task channel: {channel}")
            while True:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1)
                if msg:
                    try:
                        payload = json.loads(msg["data"])
                        await queue.put(payload)
                    except Exception as e:
                        logger.debug(f"[Redis] Invalid event: {e}")
                await asyncio.sleep(0.01)
    except Exception as e:
        logger.debug(f"[Redis] Subscription closed: {e}")
