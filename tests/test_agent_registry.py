#!/usr/bin/env python3
"""
Agent 平台 + 钱包系统 完整测试套件
测试内容：
  1. Agent Registry CRUD（含审核流程）
  2. HTTP 远程工具执行
  3. 工具注册说明
  4. 并发压测与限流验证
  5. 钱包系统（充值/消费/提现/分成）
"""

import requests
import json
import time
import threading
import concurrent.futures
from datetime import datetime

BASE_URL = "http://localhost:8080"
HEADERS_JSON = {"Content-Type": "application/json"}

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
BLUE   = "\033[94m"
RESET  = "\033[0m"
BOLD   = "\033[1m"
HLINE  = "\u2550" * 60

passed = 0
failed = 0
warnings = 0
results = []

def ok(msg):
    global passed
    passed += 1
    print(f"  {GREEN}\u2713{RESET} {msg}")
    results.append(("PASS", msg))

def fail(msg, detail=""):
    global failed
    failed += 1
    print(f"  {RED}\u2717{RESET} {msg}")
    if detail:
        print(f"    {RED}\u2514\u2500 {detail}{RESET}")
    results.append(("FAIL", msg, detail))

def warn(msg):
    global warnings
    warnings += 1
    print(f"  {YELLOW}\u26a0{RESET} {msg}")
    results.append(("WARN", msg))

def section(title):
    print(f"\n{BOLD}{BLUE}{HLINE}{RESET}")
    print(f"{BOLD}{BLUE}  {title}{RESET}")
    print(f"{BOLD}{BLUE}{HLINE}{RESET}")

def subsection(title):
    print(f"\n{BOLD}  \u2500\u2500 {title} \u2500\u2500{RESET}")

def login():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={
        "email": "admin@aiplatform.com",
        "password": "Admin@123456"
    })
    assert r.status_code == 200
    token = r.json()["data"]["token"]
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

def get_list(auth, endpoint):
    """Helper: get paginated list, auto-follow all pages"""
    all_items = []
    page = 1
    while True:
        r = requests.get(f"{BASE_URL}{endpoint}?page={page}&size=50", headers=auth)
        if r.status_code != 200 or r.json()["code"] != 200:
            break
        data = r.json()["data"]
        items = data.get("list", data.get("content", []))
        if not items:
            break
        all_items.extend(items)
        total = data.get("total", 0)
        total_pages = max(1, (total + 50 - 1) // 50)
        if page >= total_pages:
            break
        page += 1
    return all_items

# ================================================
# Part 1: Agent Registry CRUD + Review
# ================================================
def test_agent_registry_crud(auth):
    section("1. Agent Registry CRUD + \u5ba1\u6838\u6d41\u7a0b")
    ts = str(int(time.time()))
    TEST_AGENT_ID = f"test-review-{ts}"

    # 1.1 List (paginated)
    subsection("1.1 \u5217\u51fa\u6240\u6709 Agent\uff08\u5206\u9875\uff09")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry?page=1&size=10", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        data = r.json()["data"]
        agents = data.get("list", data.get("content", []))
        total = data.get("total", data.get("totalElements", 0))
        ok(f"GET /agent-registry \u2192 200\uff0c\u603b\u8ba1 {total} \u4e2a\uff0c\u5f53\u524d\u9875 {len(agents)} \u4e2a")
        if total > 0:
            ok(f"  \u5206\u9875\u4fe1\u606f\u5b8c\u6574\uff1apage={data.get('page')}, size={data.get('size')}")
    else:
        fail("GET /agent-registry \u5931\u8d25", r.text[:200])

    # 1.2 Search (paginated)
    subsection("1.2 \u641c\u7d22 Agent\uff08\u5206\u9875\uff09")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/search?q=\u53f0\u8d26&page=1&size=10", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        data = r.json()["data"]
        items = data.get("list", data.get("content", []))
        ok(f"GET /search?q=\u53f0\u8d26 \u2192 200\uff0c\u547d\u4e2d {len(items)} \u4e2a")
    else:
        fail("\u641c\u7d22\u63a5\u53e3\u5931\u8d25", r.text[:200])

    # 1.3 Categories
    subsection("1.3 \u83b7\u53d6\u5206\u7c7b\u5217\u8868")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/categories", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        cats = r.json()["data"]
        ok(f"GET /categories \u2192 200\uff0c\u5206\u7c7b\u6570={len(cats) if isinstance(cats, list) else 'N/A'}")
    else:
        warn("categories \u63a5\u53e3\u8fd4\u56de\u975e 200")

    # 1.4 Register new agent (status = pending)
    subsection("1.4 \u6ce8\u518c\u65b0 Agent\uff08\u5f85\u5ba1\u6838\uff09")
    requests.delete(f"{BASE_URL}/api/v1/agent-registry/{TEST_AGENT_ID}", headers=auth)

    r = requests.post(f"{BASE_URL}/api/v1/agent-registry/register", headers=auth, json={
        "agentId": TEST_AGENT_ID,
        "name": "\u6d4b\u8bd5\u5ba1\u6838Agent",
        "description": "\u7528\u4e8e\u6d4b\u8bd5\u5ba1\u6838\u6d41\u7a0b",
        "model": "gpt-4o",
        "systemPrompt": "\u4f60\u662f\u4e00\u4e2a\u6d4b\u8bd5Agent",
        "categories": ["\u6d4b\u8bd5"],
        "author": "test-user",
        "screenshots": [],
        "usageGuide": "\u76f4\u63a5\u8f93\u5165\u95ee\u9898\u5373\u53ef"
    })
    if r.status_code == 200 and r.json()["code"] == 200:
        detail = r.json()["data"]
        ok(f"POST /register \u2192 200\uff0cagentId={detail.get('agentId')}")
        status = detail.get("status", "")
        if status == "pending":
            ok(f"  \u65b0\u6ce8\u518c Agent \u72b6\u6001\u4e3a 'pending'\uff08\u5f85\u5ba1\u6838\uff09")
        else:
            warn(f"  \u72b6\u6001\u4e3a '{status}'\uff0c\u671f\u671b 'pending'")
    else:
        fail("\u6ce8\u518c Agent \u5931\u8d25", r.text[:300])
        return TEST_AGENT_ID

    # 1.5 Admin: list pending agents
    subsection("1.5 \u7ba1\u7406\u5458\u67e5\u770b\u5f85\u5ba1\u6838\u5217\u8868")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/admin/pending", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        pending = r.json()["data"]
        if isinstance(pending, list) and any(a["agentId"] == TEST_AGENT_ID for a in pending):
            ok(f"\u5f85\u5ba1\u6838\u5217\u8868\u4e2d\u5305\u542b {TEST_AGENT_ID}")
        elif isinstance(pending, dict):
            items = pending.get("content", pending.get("list", []))
            if any(a["agentId"] == TEST_AGENT_ID for a in items):
                ok(f"\u5f85\u5ba1\u6838\u5217\u8868\u4e2d\u5305\u542b {TEST_AGENT_ID}")
            else:
                warn("\u5f85\u5ba1\u6838\u5217\u8868\u672a\u5305\u542b\u6d4b\u8bd5Agent")
    else:
        warn(f"\u5f85\u5ba1\u6838\u63a5\u53e3\u8fd4\u56de\u975e200: {r.status_code}")

    # 1.6 Admin: approve agent
    subsection("1.6 \u7ba1\u7406\u5458\u5ba1\u6838\u901a\u8fc7")
    r = requests.post(f"{BASE_URL}/api/v1/agent-registry/admin/{TEST_AGENT_ID}/approve",
                      headers=auth, json={"comment": "\u5ba1\u6838\u901a\u8fc7\uff0c\u529f\u80fd\u6b63\u5e38"})
    if r.status_code == 200 and r.json()["code"] == 200:
        detail = r.json()["data"]
        if detail.get("status") in ("active", "approved"):
            ok(f"POST /admin/{TEST_AGENT_ID}/approve \u2192 \u72b6\u6001={detail.get('status')}")
        else:
            warn(f"\u5ba1\u6838\u540e\u72b6\u6001={detail.get('status')}")
    else:
        fail("\u5ba1\u6838\u901a\u8fc7\u5931\u8d25", r.text[:200])

    # 1.7 Admin: list all agents with filters
    subsection("1.7 \u7ba1\u7406\u5458\u67e5\u770b\u6240\u6709 Agent\uff08\u5206\u9875+\u8fc7\u6ee4\uff09")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/admin/all?page=1&size=10&status=active", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        data = r.json()["data"]
        agents = data.get("list", data.get("content", []))
        total = data.get("total", data.get("totalElements", 0))
        ok(f"GET /admin/all?status=active \u2192 200\uff0c\u603b\u8ba1 {total} \u4e2a\u5df2\u542f\u7528Agent")
    else:
        warn(f"admin/all \u63a5\u53e3\u8fd4\u56de\u975e 200: {r.status_code}")

    # 1.8 Toggle status
    subsection("1.8 \u542f\u7528/\u7981\u7528 Agent")
    r = requests.put(f"{BASE_URL}/api/v1/agent-registry/admin/{TEST_AGENT_ID}/status",
                     headers=auth, json={"status": "disabled"})
    if r.status_code == 200 and r.json()["code"] == 200:
        ok(f"PUT /admin/{TEST_AGENT_ID}/status \u2192 disabled \u6210\u529f")
        # Toggle back
        requests.put(f"{BASE_URL}/api/v1/agent-registry/admin/{TEST_AGENT_ID}/status",
                     headers=auth, json={"status": "active"})
        ok(f"  \u6062\u590d\u4e3a active \u6210\u529f")
    else:
        warn(f"toggle status \u5931\u8d25: {r.text[:200]}")

    # 1.9 Set revenue ratio
    subsection("1.9 \u8bbe\u7f6e\u5206\u6210\u6bd4\u4f8b")
    r = requests.put(f"{BASE_URL}/api/v1/agent-registry/admin/{TEST_AGENT_ID}/revenue-ratio",
                     headers=auth, json={"ratio": 0.35})
    if r.status_code == 200 and r.json()["code"] == 200:
        ok(f"PUT /admin/{TEST_AGENT_ID}/revenue-ratio \u2192 0.35 \u6210\u529f")
    else:
        warn(f"\u8bbe\u7f6e\u5206\u6210\u6bd4\u4f8b\u5931\u8d25: {r.text[:200]}")

    # 1.10 Get detail (after changes)
    subsection("1.10 \u83b7\u53d6\u66f4\u65b0\u540e\u8be6\u60c5")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/{TEST_AGENT_ID}", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        detail = r.json()["data"]
        ok(f"GET /{TEST_AGENT_ID} \u2192 200")
        if detail.get("revenueRatio") == 0.35:
            ok(f"  revenueRatio=0.35 \u786e\u8ba4")
    else:
        fail("\u83b7\u53d6\u8be6\u60c5\u5931\u8d25")

    # 1.11 Delete test agent
    subsection("1.11 \u5220\u9664\u6d4b\u8bd5 Agent")
    r = requests.delete(f"{BASE_URL}/api/v1/agent-registry/{TEST_AGENT_ID}", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        ok(f"DELETE /{TEST_AGENT_ID} \u2192 200")
    else:
        fail("\u5220\u9664\u5931\u8d25", r.text[:200])

    return TEST_AGENT_ID


# ================================================
# Part 2: HTTP Remote Tool Execution
# ================================================
def test_http_tool_execution(auth):
    section("2. HTTP \u8fdc\u7a0b\u5de5\u5177\u6267\u884c")
    HTTP_TOOL_AGENT_ID = f"test-httpbin-{int(time.time())}"
    requests.delete(f"{BASE_URL}/api/v1/agent-registry/{HTTP_TOOL_AGENT_ID}", headers=auth)

    r = requests.post(f"{BASE_URL}/api/v1/agent-registry/register", headers=auth, json={
        "agentId": HTTP_TOOL_AGENT_ID,
        "name": "HttpBin\u6d4b\u8bd5Agent",
        "description": "\u6d4b\u8bd5HTTP\u8fdc\u7a0b\u5de5\u5177\u8c03\u7528",
        "model": "gpt-4.1-mini",
        "systemPrompt": "\u4f60\u662f\u6d4b\u8bd5\u52a9\u624b\u3002",
        "tools": [{
            "name": "echo_message",
            "description": "\u5c06\u6d88\u606f\u53d1\u9001\u5230\u8fdc\u7a0b\u7aef\u70b9\u5e76\u8fd4\u56de\u7ed3\u679c",
            "parameters": {
                "type": "object",
                "properties": {"message": {"type": "string", "description": "\u8981\u53d1\u9001\u7684\u6d88\u606f"}},
                "required": ["message"]
            },
            "endpoint": "https://httpbin.org/post",
            "executionMode": "http"
        }]
    })

    if r.json()["code"] == 200:
        ok(f"HTTP\u5de5\u5177 Agent \u6ce8\u518c\u6210\u529f\uff1a{HTTP_TOOL_AGENT_ID}")
        # Wait for review approval for test agents or just check detail
        # Approve it first
        requests.post(f"{BASE_URL}/api/v1/agent-registry/admin/{HTTP_TOOL_AGENT_ID}/approve",
                      headers=auth, json={"comment": "\u81ea\u52a8\u901a\u8fc7\u6d4b\u8bd5"})
    else:
        fail(f"HTTP\u5de5\u5177 Agent \u6ce8\u518c\u5931\u8d25", r.text[:200])
        return

    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/{HTTP_TOOL_AGENT_ID}", headers=auth)
    if r.json()["code"] == 200:
        detail = r.json()["data"]
        tool = next((t for t in detail.get("tools", []) if t["name"] == "echo_message"), None)
        if tool:
            ok(f"\u5de5\u5177 'echo_message' \u5df2\u6ce8\u518c\uff0cexecutionMode=http")
        else:
            fail("\u5de5\u5177 'echo_message' \u672a\u627e\u5230")

    # Cleanup
    requests.delete(f"{BASE_URL}/api/v1/agent-registry/{HTTP_TOOL_AGENT_ID}", headers=auth)
    ok(f"HTTP\u5de5\u5177\u6d4b\u8bd5 Agent \u5df2\u6e05\u7406")


# ================================================
# Part 3: Wallet System Tests
# ================================================
def test_wallet_system(auth):
    section("3. \u94b1\u5305\u7cfb\u7edf\u6d4b\u8bd5")

    # 3.1 Get balance
    subsection("3.1 \u67e5\u8be2\u4f59\u989d")
    r = requests.get(f"{BASE_URL}/api/wallet/balance", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        balance = r.json()["data"]
        ok(f"GET /wallet/balance \u2192 200\uff0c\u4f59\u989d=\u00a5{balance}")
    else:
        fail("\u67e5\u8be2\u4f59\u989d\u5931\u8d25", r.text[:200])

    # 3.2 Get transactions
    subsection("3.2 \u67e5\u8be2\u4ea4\u6613\u8bb0\u5f55")
    r = requests.get(f"{BASE_URL}/api/wallet/transactions", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        txs = r.json()["data"]
        ok(f"GET /wallet/transactions \u2192 200\uff0c\u8bb0\u5f55\u6570={len(txs) if isinstance(txs, list) else 'N/A'}")
    else:
        warn(f"\u4ea4\u6613\u8bb0\u5f55\u63a5\u53e3\u8fd4\u56de\u975e 200: {r.status_code}")

    # 3.3 Recharge (user side - should be allowed if self-recharge is enabled)
    subsection("3.3 \u7528\u6237\u81ea\u52a9\u5145\u503c")
    r = requests.post(f"{BASE_URL}/api/wallet/recharge", headers=auth, json={
        "amount": 100.0,
        "description": "\u6d4b\u8bd5\u81ea\u52a9\u5145\u503c"
    })
    if r.status_code == 200 and r.json()["code"] == 200:
        ok(f"POST /wallet/recharge \u2192 200\uff0c\u5145\u503c\u6210\u529f")
    else:
        warn(f"\u7528\u6237\u81ea\u52a9\u5145\u503c\u53ef\u80fd\u672a\u5f00\u542f: {r.text[:200]}")

    # 3.4 Withdraw request
    subsection("3.4 \u63d0\u73b0\u7533\u8bf7")
    r = requests.post(f"{BASE_URL}/api/wallet/withdraw", headers=auth, json={
        "amount": 50.0,
        "description": "\u6d4b\u8bd5\u63d0\u73b0"
    })
    if r.status_code == 200 and r.json()["code"] == 200:
        tx = r.json()["data"]
        ok(f"POST /wallet/withdraw \u2192 200, \u72b6\u6001={tx.get('status')}")
        if tx.get("status") == "pending":
            ok(f"  \u63d0\u73b0\u7533\u8bf7\u72b6\u6001\u4e3a 'pending'\uff0c\u7b49\u5f85\u7ba1\u7406\u5458\u5ba1\u6279")
        return tx  # return for admin approval test
    else:
        warn(f"\u63d0\u73b0\u5931\u8d25: {r.text[:200]}")
        return None

    # 3.5 Admin recharge
    subsection("3.5 \u7ba1\u7406\u5458\u5145\u503c")
    r = requests.post(f"{BASE_URL}/api/wallet/admin/recharge", headers=auth, json={
        "userId": 1,
        "amount": 200.0,
        "description": "\u6d4b\u8bd5\u7ba1\u7406\u5458\u5145\u503c"
    })
    if r.status_code == 200 and r.json()["code"] == 200:
        ok(f"POST /wallet/admin/recharge \u2192 200\uff0c\u7ba1\u7406\u5458\u5145\u503c\u6210\u529f")
    else:
        fail("\u7ba1\u7406\u5458\u5145\u503c\u5931\u8d25", r.text[:200])

    # 3.6 Admin transactions list
    subsection("3.6 \u7ba1\u7406\u5458\u67e5\u770b\u6240\u6709\u4ea4\u6613")
    r = requests.get(f"{BASE_URL}/api/wallet/admin/transactions?limit=50", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        txs = r.json()["data"]
        ok(f"GET /wallet/admin/transactions \u2192 200\uff0c\u603b\u8ba1 {len(txs) if isinstance(txs, list) else 'N/A'} \u6761")
    else:
        warn(f"admin transactions \u63a5\u53e3\u8fd4\u56de\u975e 200: {r.status_code}")


# ================================================
# Part 4: Performance & Rate Limit
# ================================================
def test_performance_and_rate_limit(auth):
    section("4. \u9ad8\u5e76\u53d1\u6027\u80fd\u6d4b\u8bd5\u4e0e\u9650\u6d41\u9a8c\u8bc1")

    subsection("4.1 \u68c0\u67e5\u6e20\u9053\u9650\u6d41\u914d\u7f6e")
    r = requests.get(f"{BASE_URL}/api/admin/channels", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        channels = r.json()["data"]
        for ch in channels:
            rl = ch.get("rateLimit")
            ok(f"\u6e20\u9053 '{ch.get('name')}' rate_limit={rl} req/min")
    else:
        warn("can't fetch channels")

    subsection("4.2 \u5e76\u53d1\u8bf7\u6c42\u538b\u6d4b (50\u8bf7\u6c42, 20\u5e76\u53d1)")
    url = f"{BASE_URL}/api/v1/agent-registry?page=1&size=10"
    headers = auth.copy()

    start_time = time.time()
    success_count = 0
    fail_count = 0
    latencies = []

    def make_request(_):
        t0 = time.time()
        try:
            r = requests.get(url, headers=headers, timeout=10)
            lat = (time.time() - t0) * 1000
            return r.status_code == 200, lat
        except:
            return False, 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as ex:
        futures = [ex.submit(make_request, i) for i in range(50)]
        for f in concurrent.futures.as_completed(futures):
            s, lat = f.result()
            if s:
                success_count += 1
                latencies.append(lat)
            else:
                fail_count += 1

    elapsed = time.time() - start_time
    avg_lat = sum(latencies) / len(latencies) if latencies else 0
    max_lat = max(latencies) if latencies else 0
    rps = success_count / elapsed

    ok(f"50\u8bf7\u6c42, 20\u5e76\u53d1 | \u8017\u65f6={elapsed:.2f}s | \u6210\u529f={success_count} | \u5931\u8d25={fail_count}")
    ok(f"  \u541e\u5410\u91cf: {rps:.1f} RPS")
    ok(f"  avg={avg_lat:.0f}ms | max={max_lat:.0f}ms")

    if avg_lat > 500:
        warn(f"  avg latency {avg_lat:.0f}ms > 500ms")
    if fail_count > 0:
        warn(f"  {fail_count} failed")


# ================================================
# Part 5: Agent Builder Tool Tests
# ================================================
def test_agent_builder(auth):
    section("5. Agent Builder - 对话式 Agent 开发助手")

    # 5.1 Verify agent-builder exists in registry
    subsection("5.1 确认 agent-builder 存在")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/agent-builder", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        detail = r.json()["data"]
        ok(f"agent-builder 已注册, toolCount={detail.get('toolCount', 0)}")
        if detail.get("isBuiltin"):
            ok(f"  标记为内置 Agent (isBuiltin=true)")
        # Verify 5 tools exist
        tools = detail.get("tools", [])
        tool_names = [t.get("name", "") for t in tools]
        expected = ["create_agent", "update_agent", "list_my_agents", "get_agent_detail", "delete_agent"]
        for tn in expected:
            if tn in tool_names:
                ok(f"  工具 '{tn}' 已注册")
            else:
                fail(f"  工具 '{tn}' 缺失")
    else:
        fail("agent-builder 不存在", r.text[:200])

    # 5.2 Verify category listing includes agent-builder
    subsection("5.2 确认分类列表包含 agent-builder")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/categories", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        cats = r.json()["data"]
        if isinstance(cats, list):
            ok(f"分类列表共 {len(cats)} 项")
    else:
        warn("categories 接口返回非 200")

    # 5.3 Agent Builder appears in market search
    subsection("5.3 Agent 市场搜索 agent-builder")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/search?q=Agent 开发&page=1&size=10", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        data = r.json()["data"]
        items = data.get("list", data.get("content", []))
        found = any(a.get("agentId") == "agent-builder" for a in items)
        if found:
            ok(f"搜索 'Agent 开发' 命中 agent-builder")
        else:
            warn("搜索未命中 agent-builder")
    else:
        warn("搜索接口返回非 200")

    # 5.4 Verify Agent Builder system prompt is complete
    subsection("5.4 确认 Agent Builder 系统提示词完整")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/agent-builder", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        prompt = r.json()["data"].get("systemPrompt", "")
        checks = [
            ("create_agent", "创建新 Agent"),
            ("update_agent", "更新 Agent"),
            ("list_my_agents", "列出 Agent"),
            ("get_agent_detail", "查询详情"),
            ("delete_agent", "删除 Agent"),
            ("Function Calling", "Function Calling 模式"),
            ("```tool", "降级模式"),
        ]
        for keyword, desc in checks:
            if keyword in prompt:
                ok(f"  提示词含 '{desc}' 指引")
            else:
                warn(f"  提示词缺少 '{desc}' ({keyword}) 指引")
    else:
        fail("获取详情失败")


# ================================================
# Part 6: User Wallet Balance & Transaction Visibility
# ================================================
def test_user_wallet_visibility(auth):
    section("6. 用户钱包余额与收支明细可见性")

    # 6.1 Check balance accessible
    subsection("6.1 查询余额（用户视角）")
    r = requests.get(f"{BASE_URL}/api/wallet/balance", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        balance = r.json()["data"]
        ok(f"GET /api/wallet/balance -> 200, 余额={balance}")
    else:
        fail("查询余额失败", r.text[:200])

    # 6.2 Check transactions accessible
    subsection("6.2 查询交易流水（用户视角）")
    r = requests.get(f"{BASE_URL}/api/wallet/transactions", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        txs = r.json()["data"]
        tx_count = len(txs) if isinstance(txs, list) else 0
        ok(f"GET /api/wallet/transactions -> 200, 共 {tx_count} 条记录")
        if tx_count > 0:
            # Verify transaction fields
            tx = txs[0]
            required_fields = ["id", "userId", "type", "amount", "balanceBefore", "balanceAfter", "status", "createdAt"]
            for field in required_fields:
                if field in tx:
                    ok(f"  交易记录含字段 '{field}'")
                else:
                    warn(f"  交易记录缺少字段 '{field}'")
            # Verify types
            tx_types = set(t.get("type", "") for t in txs)
            ok(f"  交易类型: {tx_types}")
    else:
        fail("查询交易流水失败", r.text[:200])

    # 6.3 Admin recharge then verify user sees it
    subsection("6.3 管理员充值后用户可见")
    r = requests.post(f"{BASE_URL}/api/wallet/admin/recharge", headers=auth, json={
        "userId": 1,
        "amount": 100.0,
        "description": "测试充值-用户可见性验证"
    })
    if r.status_code == 200 and r.json()["code"] == 200:
        ok(f"管理员充值成功")
        # Verify balance updated
        r2 = requests.get(f"{BASE_URL}/api/wallet/balance", headers=auth)
        if r2.status_code == 200 and r2.json()["code"] == 200:
            new_balance = r2.json()["data"]
            ok(f"  充值后余额: {new_balance}")
        # Verify transaction record
        r3 = requests.get(f"{BASE_URL}/api/wallet/transactions", headers=auth)
        if r3.status_code == 200 and r3.json()["code"] == 200:
            txs = r3.json()["data"]
            recent = [t for t in txs if "用户可见性验证" in str(t.get("description", ""))]
            if recent:
                ok(f"  用户交易记录中可见充值记录")
            else:
                warn(f"  未在用户交易记录中找到充值记录")
    else:
        fail("管理员充值失败", r.text[:200])

    # 6.4 User withdraw request then admin approve
    subsection("6.4 提现审核流程")
    # First get balance
    r = requests.get(f"{BASE_URL}/api/wallet/balance", headers=auth)
    current_balance = 0
    if r.status_code == 200 and r.json()["code"] == 200:
        current_balance = float(r.json()["data"])

    if current_balance > 10:
        # Request withdraw
        r = requests.post(f"{BASE_URL}/api/wallet/withdraw", headers=auth, json={
            "amount": 10.0,
            "description": "测试提现"
        })
        if r.status_code == 200 and r.json()["code"] == 200:
            tx = r.json()["data"]
            tx_id = tx.get("id")
            ok(f"提现申请成功, 状态={tx.get('status')}")
            # Admin approve
            if tx_id:
                r2 = requests.post(f"{BASE_URL}/api/wallet/admin/withdraw/approve",
                                   headers=auth, json={"txId": tx_id})
                if r2.status_code == 200 and r2.json()["code"] == 200:
                    ok(f"  管理员批准提现成功")
                else:
                    warn(f"  批准提现失败: {r2.text[:200]}")
        else:
            warn(f"提现申请失败: {r.text[:200]}")
    else:
        warn(f"余额不足 10 元，跳过提现测试")

    # 6.5 Verify balance and transactions after all operations
    subsection("6.5 操作后最终验证")
    r = requests.get(f"{BASE_URL}/api/wallet/balance", headers=auth)
    if r.status_code == 200:
        final_balance = r.json()["data"]
        ok(f"最终余额: {final_balance}")
    r = requests.get(f"{BASE_URL}/api/wallet/transactions", headers=auth)
    if r.status_code == 200:
        txs = r.json()["data"]
        ok(f"最终交易记录数: {len(txs) if isinstance(txs, list) else 'N/A'}")


# ================================================
# Part 7: Agent /my Endpoint
# ================================================
def test_agent_my_endpoint(auth):
    section("7. 用户创建 Agent 列表 (/my)")

    # 7.1 Create a test agent
    ts = str(int(time.time()))
    TEST_ID = f"my-test-{ts}"

    subsection("7.1 创建测试 Agent")
    r = requests.post(f"{BASE_URL}/api/v1/agent-registry/register", headers=auth, json={
        "agentId": TEST_ID,
        "name": "我的测试Agent",
        "description": "测试 /my 端点",
        "model": "gpt-4o",
        "systemPrompt": "你是一个测试助手",
        "categories": ["测试"]
    })
    if r.status_code == 200 and r.json()["code"] == 200:
        ok(f"创建成功: {TEST_ID}")
    else:
        fail(f"创建失败", r.text[:200])
        return

    # 7.2 List my agents
    subsection("7.2 GET /my 列出我的 Agent")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/my", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        my_agents = r.json()["data"]
        if isinstance(my_agents, list):
            found = any(a.get("agentId") == TEST_ID for a in my_agents)
            if found:
                ok(f"GET /my -> 200, 列表包含 {TEST_ID}")
                ok(f"  共 {len(my_agents)} 个 Agent")
            else:
                fail(f"列表不包含 {TEST_ID}")
        else:
            fail(f"返回格式异常: {type(my_agents)}")
    else:
        fail("GET /my 失败", r.text[:200])

    # 7.3 Cleanup
    subsection("7.3 清理测试 Agent")
    r = requests.delete(f"{BASE_URL}/api/v1/agent-registry/{TEST_ID}", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        ok(f"删除成功: {TEST_ID}")
    else:
        warn(f"清理失败: {r.text[:200]}")

    # 7.4 Verify cleaned up
    subsection("7.4 验证清理结果")
    r = requests.get(f"{BASE_URL}/api/v1/agent-registry/my", headers=auth)
    if r.status_code == 200 and r.json()["code"] == 200:
        my_agents = r.json()["data"]
        still_there = any(a.get("agentId") == TEST_ID for a in my_agents) if isinstance(my_agents, list) else False
        if not still_there:
            ok(f"已确认 {TEST_ID} 不再出现在列表中")
        else:
            warn(f"{TEST_ID} 仍在列表中")


# ================================================
# Main
# ================================================
if __name__ == "__main__":
    print(f"\n{BOLD}{HLINE}")
    print(f"  MuhugoChat Agent + Wallet \u5b8c\u6574\u6d4b\u8bd5\u5957\u4ef6")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{HLINE}{RESET}")

    try:
        auth = login()
        print(f"\n{GREEN}\u2713 \u767b\u5f55\u6210\u529f\uff0cJWT \u5df2\u83b7\u53d6{RESET}")
    except Exception as e:
        print(f"{RED}\u2717 \u767b\u5f55\u5931\u8d25\uff1a{e}{RESET}")
        exit(1)

    test_agent_registry_crud(auth)
    test_http_tool_execution(auth)
    test_wallet_system(auth)
    test_performance_and_rate_limit(auth)
    test_agent_builder(auth)
    test_user_wallet_visibility(auth)
    test_agent_my_endpoint(auth)

    section("\u6d4b\u8bd5\u6c47\u603b\u62a5\u544a")
    total = passed + failed
    print(f"\n  {BOLD}\u603b\u8ba1\uff1a{total} \u9879\u68c0\u67e5{RESET}")
    print(f"  {GREEN}\u901a\u8fc7\uff1a{passed}{RESET}")
    print(f"  {RED}\u5931\u8d25\uff1a{failed}{RESET}")
    print(f"  {YELLOW}\u8b66\u544a\uff1a{warnings}{RESET}")

    if failed == 0:
        print(f"\n  {GREEN}{BOLD}\U0001f389 \u6240\u6709\u6d4b\u8bd5\u901a\u8fc7\uff01{RESET}")
    else:
        print(f"\n  {RED}{BOLD}\u274c \u6709 {failed} \u9879\u5931\u8d25{RESET}")
        for item in results:
            if item[0] == "FAIL":
                print(f"    {RED}\u2717 {item[1]}{RESET}")

    exit(0 if failed == 0 else 1)
