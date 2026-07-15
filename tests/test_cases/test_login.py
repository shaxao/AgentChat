"""
test_login.py — 登录/注册/忘记密码 全量测试用例
覆盖：LoginPage 三个 Tab 所有主流程 + 边界校验
"""
import sys, os
import time
import pytest
import logging
from faker import Faker

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from pages.login_page import LoginPage
from conftest import BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, USER_EMAIL, USER_PASSWORD

fake = Faker("zh_CN")
logger = logging.getLogger(__name__)


@pytest.mark.usefixtures("driver", "wait")
class TestLoginPage:
    """TC-L 系列：登录页测试"""

    # ────────────────────────────────────────────────
    # TC-L-001  页面基本元素加载
    # ────────────────────────────────────────────────
    def test_L001_page_loads(self, driver, wait):
        """TC-L-001: 打开首页，登录页应正常加载，标题可见"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        assert page.is_present("xpath", "//h1[contains(text(),'AI Chat Platform')]"), \
            "页面标题 'AI Chat Platform' 不可见"
        assert page.is_present("xpath", "//button[@role='tab' and contains(text(),'登录')]"), \
            "登录 Tab 不存在"
        assert page.is_present("xpath", "//button[@role='tab' and contains(text(),'注册')]"), \
            "注册 Tab 不存在"
        logger.info("TC-L-001 PASS：登录页加载正常")

    # ────────────────────────────────────────────────
    # TC-L-002  管理员登录（Demo 模式快速登录）
    # ────────────────────────────────────────────────
    def test_L002_admin_login_success(self, driver, wait):
        """TC-L-002: 使用管理员账号登录，应跳转到聊天页"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        page.login(ADMIN_EMAIL, ADMIN_PASSWORD)
        assert page.is_logged_in(), \
            "管理员登录后未出现聊天页（textarea 不存在）"
        logger.info("TC-L-002 PASS：管理员登录成功")
        # 清理：登出
        page.logout()

    # ────────────────────────────────────────────────
    # TC-L-003  普通用户登录
    # ────────────────────────────────────────────────
    def test_L003_user_login_success(self, driver, wait):
        """TC-L-003: 使用普通用户账号登录，应跳转到聊天页"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        page.login(USER_EMAIL, USER_PASSWORD)
        assert page.is_logged_in(), \
            "普通用户登录后未出现聊天页"
        logger.info("TC-L-003 PASS：普通用户登录成功")
        page.logout()

    # ────────────────────────────────────────────────
    # TC-L-004  错误密码登录失败
    # ────────────────────────────────────────────────
    def test_L004_login_wrong_password(self, driver, wait):
        """TC-L-004: 输入错误密码，应显示错误提示，停留在登录页"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        page.login(ADMIN_EMAIL, "wrongpassword")
        # 演示模式下会显示错误提示
        assert not page.is_logged_in(), \
            "错误密码不应成功登录"
        error = page.get_error_text()
        assert error, "错误密码时应显示错误提示"
        logger.info("TC-L-004 PASS：错误密码显示提示 '%s'", error)

    # ────────────────────────────────────────────────
    # TC-L-005  空邮箱不允许提交
    # ────────────────────────────────────────────────
    def test_L005_login_empty_email(self, driver, wait):
        """TC-L-005: 不填邮箱直接提交，HTML5 或前端验证应阻止提交"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        # 只填密码
        from pages.login_page import LoginLocators
        page.type(*LoginLocators.LOGIN_PASSWORD, "password123")
        page.click(*LoginLocators.LOGIN_BUTTON)
        time.sleep(0.5)
        # 应仍然在登录页（未跳转到聊天页）
        assert not page.is_logged_in(), \
            "空邮箱不应能提交登录"
        logger.info("TC-L-005 PASS：空邮箱无法提交")

    # ────────────────────────────────────────────────
    # TC-L-006  演示快速登录按钮
    # ────────────────────────────────────────────────
    def test_L006_quick_login_buttons(self, driver, wait):
        """TC-L-006: 演示模式下快速登录按钮应自动填充账号信息"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        # 检查快速登录按钮存在
        from pages.login_page import LoginLocators
        assert page.is_visible(*LoginLocators.QUICK_ADMIN, timeout=5), \
            "管理员快速登录按钮不可见"
        assert page.is_visible(*LoginLocators.QUICK_USER, timeout=5), \
            "普通用户快速登录按钮不可见"
        # 点击管理员按钮，验证邮箱已自动填入
        page.click(*LoginLocators.QUICK_ADMIN)
        time.sleep(0.3)
        email_val = page.get_attribute(*LoginLocators.LOGIN_EMAIL, "value")
        assert email_val == ADMIN_EMAIL, \
            f"快速登录应填入 {ADMIN_EMAIL}，实际: {email_val}"
        logger.info("TC-L-006 PASS：快速登录按钮正常")

    # ────────────────────────────────────────────────
    # TC-L-007  Tab 切换到注册页
    # ────────────────────────────────────────────────
    def test_L007_switch_to_register_tab(self, driver, wait):
        """TC-L-007: 点击注册 Tab，注册表单应显示"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        page.go_to_register()
        from pages.login_page import LoginLocators
        assert page.is_visible(*LoginLocators.REG_USERNAME, timeout=5), \
            "用户名输入框应在注册 Tab 可见"
        assert page.is_visible(*LoginLocators.REG_EMAIL, timeout=5), \
            "邮箱输入框应在注册 Tab 可见"
        logger.info("TC-L-007 PASS：注册 Tab 切换正常")

    # ────────────────────────────────────────────────
    # TC-L-008  注册流程（Demo 模式，验证码 123456）
    # ────────────────────────────────────────────────
    def test_L008_register_success_demo(self, driver, wait):
        """TC-L-008: Demo 模式下完整注册流程"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        username = f"测试用户{int(time.time()) % 10000}"
        email = f"test{int(time.time())}@example.com"
        password = "Test@12345"
        page.register(username, email, password, "123456")
        # 注册成功后应自动登录进入聊天页
        assert page.is_logged_in(), \
            "注册成功后应自动跳转聊天页"
        logger.info("TC-L-008 PASS：注册成功 username=%s", username)
        page.logout()

    # ────────────────────────────────────────────────
    # TC-L-009  注册密码不一致校验
    # ────────────────────────────────────────────────
    def test_L009_register_password_mismatch(self, driver, wait):
        """TC-L-009: 两次密码不一致时，注册表单应显示错误提示"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        page.go_to_register()
        from pages.login_page import LoginLocators
        page.type(*LoginLocators.REG_USERNAME, "testuser")
        page.type(*LoginLocators.REG_EMAIL, "mismatch@test.com")
        page.type(*LoginLocators.REG_PASSWORD, "Password123")
        page.type(*LoginLocators.REG_CONFIRM, "Different456")
        page.click(*LoginLocators.REG_SUBMIT)
        time.sleep(0.5)
        # 应显示密码不一致提示 或 表单不允许提交
        error = page.get_error_text()
        has_mismatch_hint = page.is_visible(
            "xpath",
            "//*[contains(text(),'不一致') or contains(text(),'密码')]",
            timeout=3)
        assert error or has_mismatch_hint, \
            "密码不一致时应有错误提示"
        assert not page.is_logged_in(), \
            "密码不一致时不应注册成功"
        logger.info("TC-L-009 PASS：密码不一致校验通过")

    # ────────────────────────────────────────────────
    # TC-L-010  忘记密码入口可用
    # ────────────────────────────────────────────────
    def test_L010_forgot_password_entry(self, driver, wait):
        """TC-L-010: 点击忘记密码链接，应进入重置密码表单"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        from pages.login_page import LoginLocators
        page.click(*LoginLocators.FORGOT_LINK)
        time.sleep(0.5)
        # 重置密码页面应有"重置密码"标题和"确认重置"按钮
        assert page.is_visible(
            "xpath", "//*[contains(text(),'重置密码')]", timeout=5), \
            "点击忘记密码后未出现重置密码表单"
        logger.info("TC-L-010 PASS：忘记密码入口正常")

    # ────────────────────────────────────────────────
    # TC-L-011  忘记密码返回按钮
    # ────────────────────────────────────────────────
    def test_L011_forgot_password_back(self, driver, wait):
        """TC-L-011: 在重置密码页点击返回，应回到登录 Tab"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        from pages.login_page import LoginLocators
        page.click(*LoginLocators.FORGOT_LINK)
        time.sleep(0.5)
        page.back_from_forgot()
        # 应回到登录 Tab（login-email 输入框可见）
        assert page.is_visible(*LoginLocators.LOGIN_EMAIL, timeout=5), \
            "从忘记密码返回后登录表单应可见"
        logger.info("TC-L-011 PASS：忘记密码返回正常")

    # ────────────────────────────────────────────────
    # TC-L-012  Demo 模式重置密码流程
    # ────────────────────────────────────────────────
    def test_L012_reset_password_demo(self, driver, wait):
        """TC-L-012: Demo 模式下完整重置密码流程"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        page.reset_password(ADMIN_EMAIL, "NewPass@123", "123456")
        # 成功后应有成功提示并自动回跳到登录 Tab
        success = page.get_success_text()
        assert success, "重置密码成功后应显示成功提示"
        assert "成功" in success or "成功" in success, \
            f"成功提示内容异常: {success}"
        logger.info("TC-L-012 PASS：重置密码成功提示: '%s'", success)

    # ────────────────────────────────────────────────
    # TC-L-013  登录后刷新页面保持登录态
    # ────────────────────────────────────────────────
    def test_L013_login_state_persistence(self, driver, wait):
        """TC-L-013: 登录后刷新页面，应通过 localStorage 维持登录态"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        page.login(USER_EMAIL, USER_PASSWORD)
        assert page.is_logged_in(), "登录失败"
        # 刷新页面
        driver.refresh()
        time.sleep(1.5)
        # 应仍然在聊天页（无需重新登录）
        assert page.is_logged_in(), \
            "刷新后登录态丢失（localStorage 未持久化）"
        logger.info("TC-L-013 PASS：登录态持久化正常")
        page.logout()

    # ────────────────────────────────────────────────
    # TC-L-014  登出功能（清除 localStorage）
    # ────────────────────────────────────────────────
    def test_L014_logout(self, driver, wait):
        """TC-L-014: 清除 localStorage 后刷新应回到登录页"""
        page = LoginPage(driver, wait)
        driver.execute_script("localStorage.clear();")
        page.open(BASE_URL)
        page.login(ADMIN_EMAIL, ADMIN_PASSWORD)
        assert page.is_logged_in(), "登录失败"
        # 执行登出
        page.logout()
        # 应回到登录页
        from pages.login_page import LoginLocators
        assert page.is_visible(*LoginLocators.PAGE_TITLE, timeout=8), \
            "登出后应回到登录页"
        logger.info("TC-L-014 PASS：登出功能正常")
