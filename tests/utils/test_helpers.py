"""
test_helpers.py — 测试辅助工具函数
"""
import time
import random
import string
import logging
from typing import Optional
from faker import Faker

fake = Faker("zh_CN")
logger = logging.getLogger(__name__)


def random_email(prefix: str = "test") -> str:
    """生成随机邮箱（避免注册冲突）。"""
    ts = int(time.time())
    rand = "".join(random.choices(string.ascii_lowercase, k=4))
    return f"{prefix}_{ts}_{rand}@testmail.com"


def random_username() -> str:
    """生成随机中文用户名（2-6 字）。"""
    return fake.name()[:6]


def random_password(length: int = 12) -> str:
    """生成随机密码（包含大小写字母和数字）。"""
    chars = string.ascii_letters + string.digits
    pw = (
        random.choice(string.ascii_uppercase) +
        random.choice(string.ascii_lowercase) +
        random.choice(string.digits)
    )
    pw += "".join(random.choices(chars, k=length - 3))
    return "".join(random.sample(pw, len(pw)))


def wait_for_condition(condition_fn, timeout: int = 10, interval: float = 0.5) -> bool:
    """轮询等待某条件为真，超时返回 False。"""
    start = time.time()
    while time.time() - start < timeout:
        try:
            if condition_fn():
                return True
        except Exception:
            pass
        time.sleep(interval)
    return False


def retry(fn, times: int = 3, delay: float = 1.0):
    """对函数重试若干次（用于不稳定的 UI 操作）。"""
    last_exc = None
    for i in range(times):
        try:
            return fn()
        except Exception as e:
            last_exc = e
            logger.warning("重试 %d/%d 失败: %s", i + 1, times, e)
            time.sleep(delay)
    raise last_exc
