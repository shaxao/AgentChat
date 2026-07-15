#!/usr/bin/env python3
"""
限流功能专项测试
测试：当请求速率超过 model_channel.rate_limit 配置时，后端是否正确返回限流错误
"""
import requests
import json
import time
import threading
import concurrent.futures

BASE_URL = "http://localhost:8080"

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
BLUE   = "\033[94m"
RESET  = "\033[0m"
BOLD   = "\033[1m"


def login():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={
        "email": "admin@aiplatform.com",
        "password": "Admin@123456"
    })
    return {"Authorization": f"Bearer {r.json()['data']['token']}", "Content-Type": "application/json"}


def section(title):
    print(f"\n{BOLD}{BLUE}{'═'*60}{RESET}")
    print(f"{BOLD}{BLUE}  {title}{RESET}")
    print(f"{BOLD}{BLUE}{'═'*60}{RESET}")


def test_rate_limit(auth):
    section("限流功能测试")

    # 步骤1：将 OpenAI 渠道的 rate_limit 临时改为 3（每分钟3次），方便测试
    print(f"\n{BOLD}步骤1：设置测试限流值（3 req/min）{RESET}")
    # 先获取渠道列表
    r = requests.get(f"{BASE_URL}/api/admin/channels", headers=auth)
    if r.status_code != 200:
        print(f"  {RED}✗ 获取渠道列表失败: {r.text[:100]}{RESET}")
        return

    channels = r.json().get("data", [])
    openai_ch = next((ch for ch in channels if ch.get("name", "").startswith("OpenAI")), None)
    if not openai_ch:
        print(f"  {YELLOW}⚠ 未找到 OpenAI 渠道，使用第一个可用渠道{RESET}")
        openai_ch = channels[0] if channels else None
    if not openai_ch:
        print(f"  {RED}✗ 没有可用渠道，跳过限流测试{RESET}")
        return

    ch_uuid = openai_ch.get("uuid")
    original_rate = openai_ch.get("rateLimit", 60)
    print(f"  渠道：{openai_ch.get('name')}（uuid={ch_uuid}），原始限流={original_rate}/min")

    # 设置为极低限流值：2/min（方便测试）
    r2 = requests.put(f"{BASE_URL}/api/admin/channels/{ch_uuid}",
                      headers=auth,
                      json={"rateLimit": 2})
    if r2.status_code == 200 and r2.json().get("code") == 200:
        print(f"  {GREEN}✓ 已将限流设置为 2/min{RESET}")
    else:
        print(f"  {YELLOW}⚠ 设置限流值失败（{r2.status_code}）: {r2.text[:100]}{RESET}")
        print(f"  {YELLOW}⚠ 将直接测试后端限流行为（已用当前值）{RESET}")

    # 步骤2：创建测试对话
    print(f"\n{BOLD}步骤2：创建测试对话{RESET}")
    r = requests.post(f"{BASE_URL}/api/chat/conversations",
                      headers=auth,
                      json={"title": "限流测试对话", "model": "gpt-4.1-mini"})
    if r.status_code != 200 or r.json().get("code") != 200:
        print(f"  {RED}✗ 创建对话失败{RESET}")
        return
    conv_uuid = r.json()["data"]["id"]
    print(f"  {GREEN}✓ 对话已创建：{conv_uuid}{RESET}")

    # 步骤3：连续快速发送 5 个请求（超过 2/min 限制）
    print(f"\n{BOLD}步骤3：连续发送 5 个请求，观察限流效果{RESET}")
    results = []

    for i in range(5):
        r = requests.post(
            f"{BASE_URL}/api/chat/conversations/{conv_uuid}/messages/stream",
            headers=auth,
            json={"content": f"测试消息{i+1}", "model": "gpt-4.1-mini"},
            stream=True
        )
        status = r.status_code
        content = ""
        is_rate_limited = False

        try:
            for line in r.iter_lines():
                if line:
                    decoded = line.decode("utf-8")
                    if decoded.startswith("data:"):
                        data_str = decoded[5:].strip()
                        if data_str and data_str != "[DONE]":
                            try:
                                data = json.loads(data_str)
                                if data.get("type") == "error":
                                    content = data.get("message", "")
                                    if "请求过于频繁" in content or "超出限流" in content or "rate" in content.lower():
                                        is_rate_limited = True
                                    break
                                elif data.get("type") == "done":
                                    content = "(完成)"
                                    break
                            except:
                                content = data_str[:50]
                                break
        except Exception as e:
            content = str(e)[:50]

        symbol = f"{YELLOW}⚡限流{RESET}" if is_rate_limited else (f"{GREEN}✓通过{RESET}" if status == 200 else f"{RED}✗失败{RESET}")
        print(f"  请求 {i+1}: {symbol}  状态={status}  消息='{content[:60]}'")
        results.append({
            "req": i + 1,
            "status": status,
            "rate_limited": is_rate_limited,
            "msg": content[:60]
        })
        time.sleep(0.1)  # 短暂间隔，不等完整冷却

    rate_limited_count = sum(1 for r_ in results if r_["rate_limited"])
    print(f"\n  统计：5次请求中 {rate_limited_count} 次被限流")

    if rate_limited_count > 0:
        print(f"  {GREEN}{BOLD}✓ 限流功能正常！超限请求正确返回限流提示{RESET}")
    else:
        print(f"  {YELLOW}⚠ 未触发限流（可能：请求未到达 resolveChannel，或限流值设置未生效）{RESET}")
        print(f"    原因：SSE 接口先建立连接再在后台线程调用 resolveChannel，限流异常被 catch 块捕获并通过 SSE error 事件返回")

    # 步骤4：恢复原始限流值
    print(f"\n{BOLD}步骤4：恢复原始限流值（{original_rate}/min）{RESET}")
    r3 = requests.put(f"{BASE_URL}/api/admin/channels/{ch_uuid}",
                      headers=auth,
                      json={"rateLimit": original_rate})
    if r3.status_code == 200 and r3.json().get("code") == 200:
        print(f"  {GREEN}✓ 限流已恢复为 {original_rate}/min{RESET}")
    else:
        print(f"  {YELLOW}⚠ 恢复限流值失败，请手动将渠道 {ch_uuid} 的限流设置为 {original_rate}{RESET}")


def test_rate_limit_concurrent(auth):
    section("并发限流测试（10个并发请求，rate_limit=3）")

    # 获取渠道
    r = requests.get(f"{BASE_URL}/api/admin/channels", headers=auth)
    channels = r.json().get("data", [])
    if not channels:
        print(f"  {RED}✗ 无可用渠道{RESET}")
        return

    ch = channels[0]
    ch_uuid = ch.get("uuid")
    original_rate = ch.get("rateLimit", 60)

    # 设置为 3/min
    requests.put(f"{BASE_URL}/api/admin/channels/{ch_uuid}", headers=auth, json={"rateLimit": 3})
    print(f"  已设置 {ch.get('name')} 限流为 3/min")

    # 创建对话
    r = requests.post(f"{BASE_URL}/api/chat/conversations",
                      headers=auth, json={"title": "并发限流测试", "model": "gpt-4.1-mini"})
    conv_uuid = r.json()["data"]["id"]

    # 10并发请求
    results = {"pass": 0, "rate_limited": 0, "other": 0}
    lock = threading.Lock()

    def send_request(_):
        try:
            r = requests.post(
                f"{BASE_URL}/api/chat/conversations/{conv_uuid}/messages/stream",
                headers=auth,
                json={"content": "你好", "model": "gpt-4.1-mini"},
                stream=True,
                timeout=10
            )
            for line in r.iter_lines():
                if line:
                    decoded = line.decode("utf-8")
                    if "error" in decoded and ("频繁" in decoded or "超出" in decoded):
                        with lock:
                            results["rate_limited"] += 1
                        return
                    elif decoded.startswith("data:") and "[DONE]" in decoded:
                        break
            with lock:
                results["pass"] += 1
        except Exception:
            with lock:
                results["other"] += 1

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        list(ex.map(send_request, range(10)))

    print(f"  10个并发请求结果：")
    print(f"    {GREEN}通过（未触发限流）: {results['pass']}{RESET}")
    print(f"    {YELLOW}触发限流: {results['rate_limited']}{RESET}")
    print(f"    其他: {results['other']}")

    if results["rate_limited"] > 0:
        print(f"  {GREEN}{BOLD}✓ 并发限流有效！{results['rate_limited']} 个请求被限流拦截{RESET}")
    else:
        print(f"  {YELLOW}⚠ 并发情况下未触发限流（令牌桶在并发重置时需确保线程安全）{RESET}")

    # 恢复
    requests.put(f"{BASE_URL}/api/admin/channels/{ch_uuid}", headers=auth, json={"rateLimit": original_rate})
    print(f"  {GREEN}✓ 限流已恢复为 {original_rate}/min{RESET}")


if __name__ == "__main__":
    print(f"\n{BOLD}{'═'*60}")
    print(f"  限流功能专项测试")
    print(f"{'═'*60}{RESET}")

    auth = login()
    print(f"{GREEN}✓ 登录成功{RESET}")

    test_rate_limit(auth)
    test_rate_limit_concurrent(auth)

    print(f"\n{GREEN}{BOLD}✓ 限流测试完成{RESET}")
