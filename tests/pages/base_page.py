"""
base_page.py — 所有 Page Object 的基类
封装 Selenium 常用操作，提供统一等待策略
"""
import time
import logging
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.action_chains import ActionChains
from selenium.common.exceptions import TimeoutException, NoSuchElementException

logger = logging.getLogger(__name__)


class BasePage:
    """Page Object 基类：封装通用 WebDriver 操作。"""

    # 默认等待时间（秒）
    DEFAULT_WAIT = 15
    SHORT_WAIT = 5

    def __init__(self, driver: WebDriver, wait: WebDriverWait = None):
        self.driver = driver
        self.wait = wait or WebDriverWait(driver, self.DEFAULT_WAIT)
        self.short_wait = WebDriverWait(driver, self.SHORT_WAIT)
        self.actions = ActionChains(driver)

    # ─── 导航 ───────────────────────────────────────────
    def open(self, url: str):
        logger.info("打开页面: %s", url)
        self.driver.get(url)
        time.sleep(0.5)

    @property
    def current_url(self) -> str:
        return self.driver.current_url

    @property
    def title(self) -> str:
        return self.driver.title

    # ─── 元素查找（带等待）───────────────────────────────
    def find(self, by: str, value: str):
        return self.wait.until(EC.presence_of_element_located((by, value)))

    def find_visible(self, by: str, value: str):
        return self.wait.until(EC.visibility_of_element_located((by, value)))

    def find_clickable(self, by: str, value: str):
        return self.wait.until(EC.element_to_be_clickable((by, value)))

    def find_all(self, by: str, value: str):
        self.wait.until(EC.presence_of_element_located((by, value)))
        return self.driver.find_elements(by, value)

    def is_visible(self, by: str, value: str, timeout: int = 5) -> bool:
        try:
            WebDriverWait(self.driver, timeout).until(
                EC.visibility_of_element_located((by, value)))
            return True
        except TimeoutException:
            return False

    def is_present(self, by: str, value: str, timeout: int = 3) -> bool:
        try:
            WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((by, value)))
            return True
        except TimeoutException:
            return False

    # ─── 交互操作 ────────────────────────────────────────
    def click(self, by: str, value: str):
        el = self.find_clickable(by, value)
        self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
        time.sleep(0.2)
        el.click()
        logger.debug("点击: (%s, %s)", by, value)

    def type(self, by: str, value: str, text: str, clear: bool = True):
        el = self.find_visible(by, value)
        if clear:
            el.clear()
        el.send_keys(text)
        logger.debug("输入: (%s, %s) <- '%s'", by, value, text[:30])

    def get_text(self, by: str, value: str) -> str:
        return self.find_visible(by, value).text.strip()

    def get_attribute(self, by: str, value: str, attr: str) -> str:
        return self.find(by, value).get_attribute(attr)

    def scroll_to_bottom(self):
        self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(0.3)

    def scroll_to_top(self):
        self.driver.execute_script("window.scrollTo(0, 0);")

    def wait_for_text(self, by: str, value: str, text: str, timeout: int = 15):
        WebDriverWait(self.driver, timeout).until(
            EC.text_to_be_present_in_element((by, value), text))

    def wait_invisible(self, by: str, value: str, timeout: int = 10):
        try:
            WebDriverWait(self.driver, timeout).until(
                EC.invisibility_of_element_located((by, value)))
        except TimeoutException:
            pass

    # ─── JS 辅助 ─────────────────────────────────────────
    def js_click(self, by: str, value: str):
        el = self.find(by, value)
        self.driver.execute_script("arguments[0].click();", el)

    def js_set_value(self, by: str, value: str, text: str):
        el = self.find(by, value)
        self.driver.execute_script(
            "arguments[0].value = arguments[1]; "
            "arguments[0].dispatchEvent(new Event('input', {bubbles:true})); "
            "arguments[0].dispatchEvent(new Event('change', {bubbles:true}));",
            el, text)

    def take_screenshot(self, name: str = "screenshot") -> str:
        import os
        path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            "reports", "screenshots", f"{name}_{int(time.time())}.png")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.driver.save_screenshot(path)
        return path
