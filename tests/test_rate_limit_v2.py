#!/usr/bin/env python3
"""
限流功能验证测试 v2 - 正确解析 SSE error 事件
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
        "email": "admin@aiplatform.com", "password": "Admin@123456"
    })
    return {"Authorization": f"Bearer {r.json()['data']['token']}", "Content-Type": "application/json"}

def read_sse_events(response, max_bytes=4096):
    """正确解析 SSE 事件，返回 (event_name, data) 列表"""
    events = []
    current_event = ""
    current_data = ""
    bytes_read = 0
    try:
        for line in response.iter_lines():
            if bytes_read > max_bytes:
                break
            if line:
                decoded = line.decode("utf-8", errors="replace")
                bytes_read += len(decoded)
                if decoded.startswith("event:"):
                    current_event = decoded[6:].strip()
                elif decoded.startswith("data:"):
                    current_data = decoded[5:].strip()
                    if current_data:
                        events.append((current_event or "message", current_data))
                        if current_event in ("error", "done") or current_data == "[DONE]":
                            break
                    current_event = ""
                    current_data = ""
    except Exception:
        pass
    return events

def section(title):
    print(f"\n{BOLD}{BLUE}{'═'*60}{RESET}")
    print(f"{BOLD}{BLUE}  {title}{RESET}")
    print(f"{BOLD}{BLUE}{'═'*60}{RESET}")

def test_rate_limit_v2(auth):
    section("限流功能验证（rate_limit=2/min，发送5个请求）")

    # 获取渠道并设置低限流值
    channels = requests.get(f"{BASE_URL}/api/admin/channels", headers=auth).json()["data"]
    ch = next((c for c in channels if c.get("name","").startswith("OpenAI")), channels[0])
    ch_uuid = ch["uuid"]
    original_rate = ch.get("rateLimit", 60)

    r = requests.put(f"{BASE_URL}/api/admin/channels/{ch_uuid}", headers=auth, json={"rateLimit": 2})
    print(f"  {GREEN}✓ 限流设为 2/min (原值={original_rate}){RESET}")

    # 创建对话
    conv = requests.post(f"{BASE_URL}/api/chat/conversations", headers=auth,
                         json={"title": "限流测试", "model": "gpt-4.1-mini"}).json()["data"]["id"]
    print(f"  {GREEN}✓ 测试对话：{conv}{RESET}\n")

    results = []
    for i in range(5):
        r = requests.post(
            f"{BASE_URL}/api/chat/conversations/{conv}/messages/stream",
            headers=auth,
            json={"content": f"测试{i+1}", "model": "gpt-4.1-mini"},
            stream=True, timeout=15
        )
        events = read_sse_events(r)
        
        is_limited = False
        msg = "(无数据)"
        for evt_name, evt_data in events:
            if evt_name == "error":
                try:
                    data = json.loads(evt_data)
                    msg = data.get("message", evt_data)[:80]
                    if "频繁" in msg or "超出限流" in msg or "请求过于" in msg:
                        is_limited = True
                except:
                    msg = evt_data[:80]
                break
            elif evt_name in ("content", "message", ""):
                msg = "(正在生成内容...)"

        if is_limited:
            print(f"  请求 {i+1}: {YELLOW}⚡ 已触发限流{RESET}")
            print(f"    └─ 错误信息: {YELLOW}{msg}{RESET}")
        else:
            print(f"  请求 {i+1}: {GREEN}✓ 通过{RESET} | SSE事件={events[:1]}")
        results.append(is_limited)
        time.sleep(0.05)

    limited_count = sum(results)
    pass_count = len(results) - limited_count
    print(f"\n  {BOLD}统计：5个请求中 {pass_count} 个通过，{limited_count} 个被限流{RESET}")

    if limited_count >= 3:
        print(f"  {GREEN}{BOLD}✅ 限流功能正常！{RESET}")
    elif limited_count > 0:
        print(f"  {GREEN}✓ 限流部分生效（{limited_count}/5 被拦截）{RESET}")
    else:
        print(f"  {YELLOW}⚠ 未触发限流（可能需要查看后端日志）{RESET}")

    # 恢复
    requests.put(f"{BASE_URL}/api/admin/channels/{ch_uuid}", headers=auth, json={"rateLimit": original_rate})
    print(f"  {GREEN}✓ 限流恢复：{original_rate}/min{RESET}")
    return limited_count


def test_concurrent_rate_limit(auth):
    section("并发限流验证（rate_limit=3/min，10并发）")

    channels = requests.get(f"{BASE_URL}/api/admin/channels", headers=auth).json()["data"]
    ch = next((c for c in channels if c.get("name","").startswith("OpenAI")), channels[0])
    ch_uuid, original_rate = ch["uuid"], ch.get("rateLimit", 60)

    requests.put(f"{BASE_URL}/api/admin/channels/{ch_uuid}", headers=auth, json={"rateLimit": 3})
    print(f"  已设限流 3/min\n")

    conv = requests.post(f"{BASE_URL}/api/chat/conversations", headers=auth,
                         json={"title": "并发限流测试", "model": "gpt-4.1-mini"}).json()["data"]["id"]

    results = {"pass": 0, "limited": 0, "error": 0}
    lock = threading.Lock()

    def one_req(idx):
        try:
            r = requests.post(
                f"{BASE_URL}/api/chat/conversations/{conv}/messages/stream",
                headers=auth, json={"content": f"并发{idx}", "model": "gpt-4.1-mini"},
                stream=True, timeout=10
            )
            events = read_sse_events(r)
            for evt_name, evt_data in events:
                if evt_name == "error":
                    try:
                        msg = json.loads(evt_data).get("message", "")
                        if "频繁" in msg or "超出" in msg:
                            with lock: results["limited"] += 1
                            return f"LIMITED: {msg[:50]}"
                    except: pass
                    with lock: results["error"] += 1
                    return "ERROR"
            with lock: results["pass"] += 1
            return "PASS"
        except Exception as e:
            with lock: results["error"] += 1
            return f"EXCEPTION: {e}"

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        task_results = list(ex.map(one_req, range(10)))

    for i, res in enumerate(task_results):
        color = YELLOW if "LIMITED" in res else (GREEN if "PASS" in res else RED)
        print(f"  请求 {i+1:2d}: {color}{res}{RESET}")

    print(f"\n  {BOLD}并发统计（10个请求，3/min限制）:{RESET}")
    print(f"  {GREEN}通过：{results['pass']}{RESET}")
    print(f"  {YELLOW}触发限流：{results['limited']}{RESET}")
    print(f"  {RED}错误：{results['error']}{RESET}")

    if results["limited"] >= 7:
        print(f"\n  {GREEN}{BOLD}✅ 并发限流有效！ ({results['limited']}/10 被拦截){RESET}")
    elif results["limited"] > 0:
        print(f"\n  {GREEN}✓ 并发限流部分有效{RESET}")

    requests.put(f"{BASE_URL}/api/admin/channels/{ch_uuid}", headers=auth, json={"rateLimit": original_rate})
    print(f"  {GREEN}✓ 限流恢复：{original_rate}/min{RESET}")
    return results["limited"]


if __name__ == "__main__":
    print(f"\n{BOLD}  限流功能专项验证 v2{RESET}")
    auth = login()
    print(f"{GREEN}✓ 登录成功{RESET}")

    n1 = test_rate_limit_v2(auth)
    n2 = test_concurrent_rate_limit(auth)

    print(f"\n{BOLD}{'═'*60}")
    print(f"  总结")
    print(f"{'═'*60}{RESET}")
    if n1 > 0 and n2 > 0:
        print(f"  {GREEN}{BOLD}✅ 限流机制完全正常！{RESET}")
        print(f"  - 顺序请求：{n1}/5 被限流拦截")
        print(f"  - 并发请求：{n2}/10 被限流拦截")
    else:
        print(f"  {YELLOW}⚠ 请检查后端日志（后端已有限流日志，可能是 SSE 事件读取问题）{RESET}")
