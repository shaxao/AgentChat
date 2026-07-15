"""
conftest.py — MuhugoChat AI Platform
全局 Fixture 配置：WebDriver 生命周期、测试账号、辅助工具
"""
import time
import pytest
import logging
from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from faker import Faker

# ─────────────────────────────────────────────
# 常量
# ─────────────────────────────────────────────
BASE_URL = "http://localhost:5173"
API_BASE = "http://localhost:8080/api"

# 演示模式账号（对应前端 DEMO_ACCOUNTS）
ADMIN_EMAIL = "admin@demo.com"
ADMIN_PASSWORD = "admin123"
USER_EMAIL = "user@demo.com"
USER_PASSWORD = "user123"

fake = Faker("zh_CN")

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────
# WebDriver Fixture（Session 级别：整个测试会话共用一个浏览器）
# ─────────────────────────────────────────────
@pytest.fixture(scope="session")
def driver():
    """启动 Chrome 浏览器（无头模式可选），返回 WebDriver 实例。"""
    opts = ChromeOptions()
    # 如需无头模式，取消注释下面两行：
    # opts.add_argument("--headless=new")
    # opts.add_argument("--disable-gpu")
    opts.add_argument("--window-size=1440,900")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    opts.add_argument("--lang=zh-CN")

    try:
        from webdriver_manager.chrome import ChromeDriverManager
        service = Service(ChromeDriverManager().install())
        _driver = webdriver.Chrome(service=service, options=opts)
    except Exception:
        # 降级：直接使用系统 PATH 中的 chromedriver
        _driver = webdriver.Chrome(options=opts)

    _driver.implicitly_wait(10)
    _driver.maximize_window()
    logger.info("浏览器已启动：%s", BASE_URL)
    yield _driver
    _driver.quit()
    logger.info("浏览器已关闭")


# ─────────────────────────────────────────────
# 每个测试类 / 函数级别的辅助 Fixture
# ─────────────────────────────────────────────
@pytest.fixture(scope="function")
def wait(driver):
    """返回带 15s 超时的 WebDriverWait 对象。"""
    return WebDriverWait(driver, 15)


@pytest.fixture(scope="function")
def short_wait(driver):
    """返回 5s 超时的 WebDriverWait（用于断言元素不存在）。"""
    return WebDriverWait(driver, 5)


@pytest.fixture(scope="session")
def faker_instance():
    """返回 Faker 实例（中文 locale）。"""
    return Faker("zh_CN")


# ─────────────────────────────────────────────
# 登录辅助 Fixture
# ─────────────────────────────────────────────
@pytest.fixture(scope="function")
def logged_in_admin(driver, wait):
    """以管理员账号登录，测试结束后登出（清除 localStorage）。"""
    from pages.login_page import LoginPage
    page = LoginPage(driver, wait)
    page.open(BASE_URL)
    page.login(ADMIN_EMAIL, ADMIN_PASSWORD)
    # 等待进入聊天页
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "[data-testid='chat-page'], .chat-page, textarea, [placeholder*='消息']")))
    yield driver
    driver.execute_script("localStorage.clear(); sessionStorage.clear();")
    driver.refresh()
    time.sleep(1)


@pytest.fixture(scope="function")
def logged_in_user(driver, wait):
    """以普通用户账号登录，测试结束后登出。"""
    from pages.login_page import LoginPage
    page = LoginPage(driver, wait)
    page.open(BASE_URL)
    page.login(USER_EMAIL, USER_PASSWORD)
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "textarea, [placeholder*='消息']")))
    yield driver
    driver.execute_script("localStorage.clear(); sessionStorage.clear();")
    driver.refresh()
    time.sleep(1)


# ─────────────────────────────────────────────
# 截图 Hook：测试失败自动截图
# ─────────────────────────────────────────────
@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if report.when == "call" and report.failed:
        driver = item.funcargs.get("driver")
        if driver:
            import os
            screenshots_dir = os.path.join(os.path.dirname(__file__), "reports", "screenshots")
            os.makedirs(screenshots_dir, exist_ok=True)
            filename = f"{item.nodeid.replace('/', '_').replace('::', '_')}.png"
            filepath = os.path.join(screenshots_dir, filename)
            driver.save_screenshot(filepath)
            logger.info("失败截图已保存：%s", filepath)
            # 将截图路径写入 extra（pytest-html）
            try:
                from pytest_html import extras
                if hasattr(report, "extra"):
                    report.extra.append(extras.image(filepath))
            except Exception:
                pass
