"""
chat_page.py — 聊天主页面 Page Object
对应 app/src/pages/ChatPage.tsx + components/chat/
"""
import time
import logging
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from .base_page import BasePage

logger = logging.getLogger(__name__)


class ChatLocators:
    # ── 侧边栏 ──────────────────────────────────────────
    SIDEBAR           = (By.CSS_SELECTOR, "aside, [class*='sidebar'], [class*='Sidebar']")
    NEW_CHAT_BTN      = (By.XPATH, "//*[contains(@class,'sidebar') or contains(@class,'Sidebar')]//button[contains(.,'新建') or contains(.,'新对话') or contains(.,'New')]")
    CONV_ITEM         = (By.CSS_SELECTOR, "[class*='conversation'], [class*='chat-item']")
    CONV_TITLE        = (By.CSS_SELECTOR, "[class*='conversation'] span, [class*='chat-item'] span")
    SEARCH_CONV       = (By.CSS_SELECTOR, "input[placeholder*='搜索']")

    # ── 聊天主区域 ──────────────────────────────────────
    MESSAGE_INPUT     = (By.CSS_SELECTOR, "textarea")
    SEND_BUTTON       = (By.CSS_SELECTOR, "button[type='submit'], button[aria-label*='发送']")
    MESSAGE_BUBBLE    = (By.CSS_SELECTOR, "[class*='message'], [class*='bubble'], [class*='Message']")
    USER_MESSAGE      = (By.CSS_SELECTOR, "[class*='user'], [class*='User']")
    ASSISTANT_MESSAGE = (By.CSS_SELECTOR, "[class*='assistant'], [class*='Assistant']")

    # 发送按钮（通用）：找含 SVG 的 button 在 textarea 同级
    SEND_BTN_GENERIC  = (By.XPATH, "//button[.//*[local-name()='svg']][last()]")

    # ── 模型选择 ────────────────────────────────────────
    MODEL_SELECTOR    = (By.CSS_SELECTOR, "select[name*='model'], [class*='model-select'], button[class*='model']")

    # ── 顶部导航 ────────────────────────────────────────
    SETTINGS_BTN      = (By.CSS_SELECTOR, "button[aria-label*='设置'], [class*='settings']")
    ADMIN_ENTRY       = (By.XPATH, "//*[contains(text(),'管理') or contains(text(),'Admin')]")

    # ── 对话操作菜单（右键 / hover 菜单）────────────────
    CONV_DELETE_BTN   = (By.XPATH, "//*[contains(text(),'删除') and contains(@class,'menu')]")
    CONV_PIN_BTN      = (By.XPATH, "//*[contains(text(),'置顶') and contains(@class,'menu')]")
    CONV_RENAME_INPUT = (By.CSS_SELECTOR, "input[placeholder*='对话名']")

    # ── 消息操作 ────────────────────────────────────────
    CLEAR_MSG_BTN     = (By.XPATH, "//*[contains(text(),'清空')]")

    # ── 欢迎提示 ─────────────────────────────────────────
    WELCOME_TEXT      = (By.XPATH, "//*[contains(text(),'新对话') or contains(text(),'开始') or contains(text(),'AI')]")


class ChatPage(BasePage):
    """聊天主页 PO。"""

    def is_loaded(self, timeout: int = 15) -> bool:
        """判断聊天页是否加载完成（textarea 出现）。"""
        return self.is_visible(*ChatLocators.MESSAGE_INPUT, timeout=timeout)

    # ─── 消息发送 ──────────────────────────────────────────
    def send_message(self, text: str, wait_reply: bool = True):
        """在输入框输入文本并发送（Enter 键或点击发送按钮）。"""
        logger.info("发送消息: %s", text[:50])
        input_el = self.find_visible(*ChatLocators.MESSAGE_INPUT)
        input_el.clear()
        input_el.send_keys(text)
        time.sleep(0.3)
        # 优先使用 Enter 发送（Shift+Enter 换行，Enter 发送）
        input_el.send_keys(Keys.RETURN)
        if wait_reply:
            # 等待 AI 回复出现（最多 30s）
            time.sleep(2)
        logger.info("消息已发送")

    def get_messages(self) -> list:
        """获取当前对话所有消息气泡的文本列表。"""
        try:
            bubbles = self.driver.find_elements(*ChatLocators.MESSAGE_BUBBLE)
            return [b.text.strip() for b in bubbles if b.text.strip()]
        except Exception:
            return []

    def get_last_message(self) -> str:
        """获取最后一条消息的文本。"""
        msgs = self.get_messages()
        return msgs[-1] if msgs else ""

    def wait_for_reply(self, timeout: int = 30):
        """等待 AI 回复加载完成（流式输出结束）。"""
        # 等待加载指示器消失，或新消息出现
        time.sleep(2)
        logger.info("等待 AI 回复中...")

    # ─── 新建对话 ──────────────────────────────────────────
    def new_conversation(self):
        """点击新建对话按钮。"""
        try:
            self.click(*ChatLocators.NEW_CHAT_BTN)
            time.sleep(0.5)
            logger.info("新建对话完成")
        except Exception as e:
            logger.warning("新建对话失败: %s", e)

    # ─── 对话列表 ──────────────────────────────────────────
    def get_conversation_count(self) -> int:
        """获取侧边栏对话数量。"""
        try:
            items = self.driver.find_elements(*ChatLocators.CONV_ITEM)
            return len(items)
        except Exception:
            return 0

    def click_conversation(self, index: int = 0):
        """点击指定序号的对话。"""
        items = self.driver.find_elements(*ChatLocators.CONV_ITEM)
        if items and index < len(items):
            items[index].click()
            time.sleep(0.5)

    def search_conversation(self, keyword: str):
        """在搜索框搜索对话。"""
        if self.is_visible(*ChatLocators.SEARCH_CONV, timeout=3):
            self.type(*ChatLocators.SEARCH_CONV, keyword)
            time.sleep(0.5)

    # ─── 输入框状态 ───────────────────────────────────────
    def get_input_value(self) -> str:
        try:
            return self.find(*ChatLocators.MESSAGE_INPUT).get_attribute("value")
        except Exception:
            return ""

    def is_input_empty(self) -> bool:
        return self.get_input_value().strip() == ""

    def input_text(self, text: str):
        """只输入文本，不发送。"""
        input_el = self.find_visible(*ChatLocators.MESSAGE_INPUT)
        input_el.clear()
        input_el.send_keys(text)

    def clear_input(self):
        """清空输入框。"""
        input_el = self.find_visible(*ChatLocators.MESSAGE_INPUT)
        input_el.clear()

    # ─── 页面状态 ─────────────────────────────────────────
    def get_page_title(self) -> str:
        return self.driver.title

    def is_admin_visible(self) -> bool:
        """管理员入口是否可见（管理员账号登录后才会出现）。"""
        return self.is_visible(*ChatLocators.ADMIN_ENTRY, timeout=5)
