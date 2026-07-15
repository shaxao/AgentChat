"""
login_page.py — 登录/注册/忘记密码 Page Object
对应 app/src/pages/LoginPage.tsx
"""
import time
import logging
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from .base_page import BasePage

logger = logging.getLogger(__name__)

# ────────────────────────────────────────────────────────
# 选择器常量（与 LoginPage.tsx 中的 id / placeholder 对应）
# ────────────────────────────────────────────────────────
class LoginLocators:
    # Tab 切换
    TAB_LOGIN     = (By.XPATH, "//button[@role='tab' and contains(text(),'登录')]")
    TAB_REGISTER  = (By.XPATH, "//button[@role='tab' and contains(text(),'注册')]")

    # 登录表单
    LOGIN_EMAIL    = (By.ID, "login-email")
    LOGIN_PASSWORD = (By.ID, "login-password")
    LOGIN_BUTTON   = (By.XPATH, "//button[@type='submit' and contains(text(),'登录')]")

    # 演示快速登录按钮
    QUICK_ADMIN    = (By.XPATH, "//button[contains(text(),'管理员')]")
    QUICK_USER     = (By.XPATH, "//button[contains(text(),'普通用户')]")

    # 注册表单（无 id，按 placeholder 找）
    REG_USERNAME   = (By.XPATH, "//input[@placeholder='2-20 位字符']")
    REG_EMAIL      = (By.XPATH, "//input[@type='email' and @placeholder='name@example.com']")
    REG_SEND_CODE  = (By.XPATH, "//button[contains(.,'验证码') and @type='button']")
    REG_PASSWORD   = (By.XPATH, "//input[@type='password' and @placeholder='至少 8 位']")
    REG_CONFIRM    = (By.XPATH, "//input[@type='password' and @placeholder='再次输入密码']")
    REG_SUBMIT     = (By.XPATH, "//button[@type='submit' and contains(text(),'创建账号')]")

    # 忘记密码链接
    FORGOT_LINK    = (By.XPATH, "//button[contains(text(),'忘记密码')]")
    FORGOT_EMAIL   = (By.XPATH, "//input[@type='email' and @placeholder='name@example.com']")
    FORGOT_SEND    = (By.XPATH, "//button[contains(.,'获取验证码') and @type='button']")
    FORGOT_NEW_PWD = (By.XPATH, "//input[@type='password' and @placeholder='至少 8 位']")
    FORGOT_CONFIRM = (By.XPATH, "//input[@type='password' and @placeholder='再次输入新密码']")
    FORGOT_BACK    = (By.XPATH, "//button[.//*[local-name()='svg']]")  # ArrowLeft 按钮
    FORGOT_SUBMIT  = (By.XPATH, "//button[@type='submit' and contains(text(),'确认重置')]")

    # 提示信息
    ERROR_MSG      = (By.CSS_SELECTOR, ".text-destructive")
    SUCCESS_MSG    = (By.CSS_SELECTOR, ".text-green-600, .text-green-400")

    # 页面标题
    PAGE_TITLE     = (By.XPATH, "//h1[contains(text(),'AI Chat Platform')]")

    # 登录成功后的聊天页面特征
    CHAT_INPUT     = (By.CSS_SELECTOR, "textarea")


class LoginPage(BasePage):
    """登录、注册、忘记密码页面 PO。"""

    def open(self, base_url: str):
        super().open(base_url)
        self.wait.until(EC.visibility_of_element_located(LoginLocators.PAGE_TITLE))
        logger.info("登录页面加载成功")

    # ─── 登录 ─────────────────────────────────────────────
    def login(self, email: str, password: str):
        """标准登录流程（填写邮箱 + 密码 → 提交）。"""
        logger.info("登录账号: %s", email)
        self.click(*LoginLocators.TAB_LOGIN)
        time.sleep(0.3)
        self.type(*LoginLocators.LOGIN_EMAIL, email)
        self.type(*LoginLocators.LOGIN_PASSWORD, password)
        self.click(*LoginLocators.LOGIN_BUTTON)
        time.sleep(1.5)

    def quick_login_admin(self):
        """点击演示快速登录 - 管理员。"""
        self.click(*LoginLocators.QUICK_ADMIN)
        time.sleep(0.3)
        self.click(*LoginLocators.LOGIN_BUTTON)
        time.sleep(1.5)

    def quick_login_user(self):
        """点击演示快速登录 - 普通用户。"""
        self.click(*LoginLocators.QUICK_USER)
        time.sleep(0.3)
        self.click(*LoginLocators.LOGIN_BUTTON)
        time.sleep(1.5)

    def is_logged_in(self) -> bool:
        """判断是否已进入聊天页（出现 textarea）。"""
        return self.is_visible(*LoginLocators.CHAT_INPUT, timeout=8)

    # ─── 错误 / 成功提示 ──────────────────────────────────
    def get_error_text(self) -> str:
        try:
            return self.get_text(*LoginLocators.ERROR_MSG)
        except Exception:
            return ""

    def get_success_text(self) -> str:
        try:
            return self.get_text(*LoginLocators.SUCCESS_MSG)
        except Exception:
            return ""

    # ─── 注册 ─────────────────────────────────────────────
    def go_to_register(self):
        self.click(*LoginLocators.TAB_REGISTER)
        time.sleep(0.3)

    def register(self, username: str, email: str, password: str,
                 verify_code: str = "123456"):
        """演示模式注册流程（验证码固定 123456）。"""
        logger.info("注册账号: %s / %s", username, email)
        self.go_to_register()
        self.type(*LoginLocators.REG_USERNAME, username)
        self.type(*LoginLocators.REG_EMAIL, email)
        # 发送验证码
        try:
            self.click(*LoginLocators.REG_SEND_CODE)
            time.sleep(0.8)
        except Exception:
            pass
        # 填写 6 位验证码格子
        self._fill_verify_code(verify_code)
        self.type(*LoginLocators.REG_PASSWORD, password)
        self.type(*LoginLocators.REG_CONFIRM, password)
        self.click(*LoginLocators.REG_SUBMIT)
        time.sleep(1.5)

    def _fill_verify_code(self, code: str):
        """填写 6 个独立 input 的验证码框。"""
        inputs = self.driver.find_elements(
            By.CSS_SELECTOR,
            "input[inputmode='numeric'][maxlength='1']")
        for i, ch in enumerate(code[:6]):
            if i < len(inputs):
                inputs[i].clear()
                inputs[i].send_keys(ch)
                time.sleep(0.05)

    # ─── 忘记密码 ─────────────────────────────────────────
    def go_to_forgot(self):
        self.click(*LoginLocators.FORGOT_LINK)
        time.sleep(0.3)

    def reset_password(self, email: str, new_password: str,
                       verify_code: str = "123456"):
        """演示模式重置密码流程。"""
        logger.info("重置密码: %s", email)
        self.go_to_forgot()
        self.type(*LoginLocators.FORGOT_EMAIL, email)
        try:
            self.click(*LoginLocators.FORGOT_SEND)
            time.sleep(0.8)
        except Exception:
            pass
        self._fill_verify_code(verify_code)
        self.type(*LoginLocators.FORGOT_NEW_PWD, new_password)
        self.type(*LoginLocators.FORGOT_CONFIRM, new_password)
        self.click(*LoginLocators.FORGOT_SUBMIT)
        time.sleep(1.5)

    def back_from_forgot(self):
        """点击返回箭头回到登录页。"""
        self.click(*LoginLocators.FORGOT_BACK)
        time.sleep(0.3)

    # ─── 登出 ─────────────────────────────────────────────
    def logout(self):
        """通过清除 localStorage 实现登出。"""
        self.driver.execute_script("localStorage.clear(); sessionStorage.clear();")
        self.driver.refresh()
        time.sleep(1)
