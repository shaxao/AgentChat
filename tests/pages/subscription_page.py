"""
subscription_page.py — 订阅套餐页面 Page Object
对应 app/src/pages/SubscriptionPage.tsx
通常通过聊天页内的"升级套餐"或"订阅"按钮进入
"""
import time
import logging
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from .base_page import BasePage

logger = logging.getLogger(__name__)


class SubscriptionLocators:
    # ── 进入订阅页 ──────────────────────────────────────────
    # 聊天页左下角或顶部导航的"升级"按钮
    UPGRADE_ENTRY     = (By.XPATH,
        "//button[contains(.,'升级') or contains(.,'Upgrade') or contains(.,'订阅')]")
    SUB_PAGE_MARKER   = (By.XPATH,
        "//*[contains(text(),'套餐') or contains(text(),'Plan') or contains(text(),'订阅方案')]")

    # ── 套餐卡片 ────────────────────────────────────────────
    PLAN_CARDS        = (By.CSS_SELECTOR, "[class*='plan'], [class*='Plan'], [class*='card']")
    PLAN_NAME         = (By.CSS_SELECTOR, "h2, h3, [class*='plan-name']")
    PLAN_PRICE        = (By.XPATH, "//*[contains(text(),'¥') or contains(text(),'免费') or contains(text(),'Free')]")
    SUBSCRIBE_BTN     = (By.XPATH, "//button[contains(.,'订阅') or contains(.,'升级') or contains(.,'立即')]")
    FREE_BTN          = (By.XPATH, "//button[contains(.,'免费') or contains(.,'Free')]")
    PRO_BTN           = (By.XPATH, "//button[contains(.,'Pro') or contains(.,'专业')]")
    ENTERPRISE_BTN    = (By.XPATH, "//button[contains(.,'企业') or contains(.,'Enterprise')]")

    # ── 套餐特性列表 ────────────────────────────────────────
    FEATURE_LIST      = (By.CSS_SELECTOR, "ul li, [class*='feature']")

    # ── 当前套餐标记 ────────────────────────────────────────
    CURRENT_PLAN      = (By.XPATH,
        "//*[contains(text(),'当前套餐') or contains(text(),'Current')]")

    # ── 返回聊天页 ────────────────────────────────────────
    BACK_BTN          = (By.XPATH,
        "//button[contains(.,'返回') or contains(.,'Back') or @aria-label='返回']")


class SubscriptionPage(BasePage):
    """订阅套餐页 PO。"""

    def enter_subscription(self):
        """从聊天页进入订阅页。"""
        logger.info("尝试进入订阅页...")
        for selector in [
            SubscriptionLocators.UPGRADE_ENTRY,
            (By.XPATH, "//button[contains(.,'套餐')]"),
            (By.XPATH, "//a[contains(.,'升级')]"),
        ]:
            if self.is_visible(*selector, timeout=3):
                self.click(*selector)
                time.sleep(0.8)
                return True
        logger.warning("未找到订阅页入口")
        return False

    def is_subscription_page(self) -> bool:
        """是否已在订阅页面（出现套餐相关文本）。"""
        return self.is_visible(*SubscriptionLocators.SUB_PAGE_MARKER, timeout=5)

    def get_plan_count(self) -> int:
        """获取套餐卡片数量。"""
        try:
            cards = self.driver.find_elements(*SubscriptionLocators.PLAN_CARDS)
            return len(cards)
        except Exception:
            return 0

    def get_plan_names(self) -> list:
        """获取所有套餐名称。"""
        try:
            names = self.driver.find_elements(*SubscriptionLocators.PLAN_NAME)
            return [n.text.strip() for n in names if n.text.strip()]
        except Exception:
            return []

    def get_price_elements_count(self) -> int:
        """获取价格元素数量。"""
        try:
            prices = self.driver.find_elements(*SubscriptionLocators.PLAN_PRICE)
            return len(prices)
        except Exception:
            return 0

    def click_subscribe(self, plan_name: str = "pro"):
        """点击指定套餐的订阅按钮。"""
        mapping = {
            "free": SubscriptionLocators.FREE_BTN,
            "pro": SubscriptionLocators.PRO_BTN,
            "enterprise": SubscriptionLocators.ENTERPRISE_BTN,
        }
        locator = mapping.get(plan_name.lower(), SubscriptionLocators.SUBSCRIBE_BTN)
        try:
            self.click(*locator)
            time.sleep(1)
            logger.info("点击订阅: %s", plan_name)
            return True
        except Exception as e:
            logger.warning("订阅点击失败 %s: %s", plan_name, e)
            return False

    def go_back(self):
        """返回上一页。"""
        try:
            self.click(*SubscriptionLocators.BACK_BTN)
            time.sleep(0.5)
        except Exception:
            self.driver.back()
            time.sleep(0.5)
