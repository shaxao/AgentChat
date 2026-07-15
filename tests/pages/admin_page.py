"""
admin_page.py — 管理后台页面 Page Object
对应 app/src/pages/AdminPage.tsx
管理后台通过聊天页内的 Tab / 菜单进入
"""
import time
import logging
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from .base_page import BasePage

logger = logging.getLogger(__name__)


class AdminLocators:
    # ── 进入管理后台 ───────────────────────────────────────
    # 管理员头像/菜单按钮（顶部右侧或侧边栏底部）
    ADMIN_TRIGGER     = (By.XPATH,
        "//*[contains(@class,'avatar') or contains(@class,'user-menu')]//button | "
        "//button[contains(.,'管理') or @aria-label='管理']")
    # 直接找包含"管理控制台"或"Admin"的导航项
    ADMIN_NAV         = (By.XPATH,
        "//*[contains(text(),'管理控制台') or contains(text(),'Admin') or "
        "contains(text(),'管理后台')]")

    # ── 管理后台 Tab ──────────────────────────────────────
    TAB_OVERVIEW      = (By.XPATH, "//button[@role='tab' and (contains(.,'概览') or contains(.,'Overview'))]")
    TAB_USERS         = (By.XPATH, "//button[@role='tab' and (contains(.,'用户') or contains(.,'Users'))]")
    TAB_CHANNELS      = (By.XPATH, "//button[@role='tab' and (contains(.,'渠道') or contains(.,'Channel'))]")
    TAB_MODELS        = (By.XPATH, "//button[@role='tab' and (contains(.,'模型') or contains(.,'Model'))]")
    TAB_SUBSCRIPTIONS = (By.XPATH, "//button[@role='tab' and (contains(.,'订阅') or contains(.,'Sub'))]")
    TAB_LOGS          = (By.XPATH, "//button[@role='tab' and (contains(.,'日志') or contains(.,'Log'))]")
    TAB_PLANS         = (By.XPATH, "//button[@role='tab' and (contains(.,'套餐') or contains(.,'Plan'))]")

    # ── 概览统计卡片 ───────────────────────────────────────
    STAT_CARDS        = (By.CSS_SELECTOR, "[class*='card'], [class*='Card']")
    STAT_NUMBER       = (By.CSS_SELECTOR, "[class*='text-2xl'], [class*='text-3xl'], h2, h3")

    # ── 用户管理 ───────────────────────────────────────────
    USER_TABLE        = (By.CSS_SELECTOR, "table, [role='table']")
    USER_ROWS         = (By.CSS_SELECTOR, "tbody tr, [role='row']:not([role='columnheader'])")
    USER_SEARCH       = (By.CSS_SELECTOR, "input[placeholder*='搜索'], input[placeholder*='用户']")
    ADD_USER_BTN      = (By.XPATH, "//button[contains(.,'添加用户') or contains(.,'新增')]")
    USER_NAME_INPUT   = (By.CSS_SELECTOR, "input[placeholder*='用户名'], input[name='name']")
    USER_EMAIL_INPUT  = (By.CSS_SELECTOR, "input[placeholder*='邮箱'], input[type='email']")
    USER_PWD_INPUT    = (By.CSS_SELECTOR, "input[placeholder*='密码'], input[type='password']")
    DIALOG_SUBMIT     = (By.XPATH, "//button[@type='submit' or (contains(.,'确定') and @class)]")
    DIALOG_CANCEL     = (By.XPATH, "//button[contains(.,'取消')]")

    # ── 渠道管理 ───────────────────────────────────────────
    ADD_CHANNEL_BTN   = (By.XPATH, "//button[contains(.,'添加渠道') or contains(.,'新增渠道')]")
    CHANNEL_ROWS      = (By.CSS_SELECTOR, "tbody tr")
    CHANNEL_NAME_COL  = (By.CSS_SELECTOR, "td:first-child")
    TEST_CHANNEL_BTN  = (By.XPATH, "//button[contains(.,'测试')]")

    # ── 模型管理 ───────────────────────────────────────────
    ADD_MODEL_BTN     = (By.XPATH, "//button[contains(.,'添加模型') or contains(.,'新增模型')]")
    MODEL_ROWS        = (By.CSS_SELECTOR, "tbody tr")

    # ── 日志 ───────────────────────────────────────────────
    LOG_ROWS          = (By.CSS_SELECTOR, "tbody tr")
    LOG_TABLE         = (By.CSS_SELECTOR, "table")

    # ── 套餐管理 ───────────────────────────────────────────
    ADD_PLAN_BTN      = (By.XPATH, "//button[contains(.,'添加套餐') or contains(.,'新增套餐')]")
    PLAN_CARDS        = (By.CSS_SELECTOR, "[class*='plan'], [class*='Plan']")

    # ── 通用 Dialog ────────────────────────────────────────
    DIALOG            = (By.CSS_SELECTOR, "[role='dialog'], [class*='Dialog'], [class*='modal']")
    DIALOG_TITLE      = (By.CSS_SELECTOR, "[role='dialog'] h2, [class*='Dialog'] h2")
    CLOSE_DIALOG      = (By.CSS_SELECTOR, "button[aria-label='Close'], [class*='close']")


class AdminPage(BasePage):
    """管理后台 PO。"""

    def enter_admin(self):
        """尝试进入管理后台（点击导航入口）。"""
        logger.info("尝试进入管理后台...")
        # 方法1：查找包含"管理"文字的导航按钮
        for selector in [
            (By.XPATH, "//*[contains(text(),'管理控制台')]"),
            (By.XPATH, "//*[contains(text(),'管理后台')]"),
            (By.XPATH, "//*[contains(text(),'Admin')]"),
            (By.XPATH, "//button[contains(.,'管理')]"),
        ]:
            if self.is_visible(*selector, timeout=3):
                self.click(*selector)
                time.sleep(0.8)
                return True
        logger.warning("未找到管理后台入口，可能当前账号无权限或已在管理页")
        return False

    def is_admin_loaded(self) -> bool:
        """判断管理后台是否加载完成（有 Tab 列表）。"""
        return self.is_visible(*AdminLocators.TAB_OVERVIEW, timeout=8) or \
               self.is_visible(*AdminLocators.TAB_USERS, timeout=3)

    # ─── Tab 切换 ─────────────────────────────────────────
    def go_to_users(self):
        self._click_tab(AdminLocators.TAB_USERS, "用户管理")

    def go_to_overview(self):
        self._click_tab(AdminLocators.TAB_OVERVIEW, "概览")

    def go_to_channels(self):
        self._click_tab(AdminLocators.TAB_CHANNELS, "渠道管理")

    def go_to_models(self):
        self._click_tab(AdminLocators.TAB_MODELS, "模型管理")

    def go_to_logs(self):
        self._click_tab(AdminLocators.TAB_LOGS, "日志")

    def go_to_plans(self):
        self._click_tab(AdminLocators.TAB_PLANS, "套餐管理")

    def go_to_subscriptions(self):
        self._click_tab(AdminLocators.TAB_SUBSCRIPTIONS, "订阅管理")

    def _click_tab(self, locator: tuple, name: str):
        try:
            self.click(*locator)
            time.sleep(0.5)
            logger.info("切换到 Tab: %s", name)
        except Exception as e:
            logger.warning("切换 Tab %s 失败: %s", name, e)

    # ─── 统计概览 ─────────────────────────────────────────
    def get_stat_cards_count(self) -> int:
        try:
            return len(self.driver.find_elements(*AdminLocators.STAT_CARDS))
        except Exception:
            return 0

    # ─── 用户管理 ─────────────────────────────────────────
    def get_user_count(self) -> int:
        try:
            rows = self.driver.find_elements(*AdminLocators.USER_ROWS)
            return len(rows)
        except Exception:
            return 0

    def search_user(self, keyword: str):
        if self.is_visible(*AdminLocators.USER_SEARCH, timeout=3):
            self.type(*AdminLocators.USER_SEARCH, keyword)
            time.sleep(0.8)

    def is_table_visible(self) -> bool:
        return self.is_visible(*AdminLocators.USER_TABLE, timeout=5)

    def is_log_table_visible(self) -> bool:
        return self.is_visible(*AdminLocators.LOG_TABLE, timeout=5)

    def get_log_count(self) -> int:
        try:
            return len(self.driver.find_elements(*AdminLocators.LOG_ROWS))
        except Exception:
            return 0
