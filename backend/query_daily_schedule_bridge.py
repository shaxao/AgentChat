#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
排班查询桥接脚本
由 MuhugoChat Agent 工具通过 script:// 协议调用

输入（stdin JSON）：
  {"tool_name": "query_daily_schedule", "arguments": {"date": "2025-06-11"}, "session_id": "xxx"}

输出（stdout JSON）：
  {"status": "ok", "date": "2025-06-11", "staff_list": [...]}
"""

import sys
import json
import os
import datetime


def parse_date(date_str):
    """
    支持多种日期描述：
      - YYYY-MM-DD
      - today / 今天 / 今日
      - tomorrow / 明天 / 明日
      - yesterday / 昨天 / 昨日
    返回 YYYY-MM-DD 格式字符串
    """
    if not date_str or not str(date_str).strip():
        return datetime.date.today().isoformat()

    ds = str(date_str).strip().lower()

    if ds in ("today", "今天", "今日"):
        return datetime.date.today().isoformat()
    if ds in ("tomorrow", "明天", "明日"):
        return (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
    if ds in ("yesterday", "昨天", "昨日"):
        return (datetime.date.today() - datetime.timedelta(days=1)).isoformat()

    # 尝试解析 YYYY-MM-DD / YYYY/MM/DD 等格式
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            d = datetime.datetime.strptime(ds, fmt).date()
            return d.isoformat()
        except ValueError:
            continue

    # 兜底：返回今天
    return datetime.date.today().isoformat()


def main():
    # 读取 stdin
    try:
        raw = sys.stdin.read().strip()
        if not raw:
            print(json.dumps({"error": "缺少输入参数"}, ensure_ascii=False))
            sys.exit(1)
        payload = json.loads(raw)
    except Exception as e:
        print(json.dumps({"error": f"参数解析失败: {e}"}, ensure_ascii=False))
        sys.exit(1)

    tool_name = payload.get("tool_name", "")
    arguments = payload.get("arguments", {})
    session_id = payload.get("session_id", "")

    # 提取日期参数
    date_raw = arguments.get("date", "")
    date_str = parse_date(date_raw)

    # 获取 OA 凭据（优先环境变量）
    login_id = os.environ.get("OA_LOGIN_ID", "")
    oa_password = os.environ.get("OA_PASSWORD", "")

    # 如果环境变量没配置，尝试从 session 上下文获取
    # （session_id 可用来查数据库获取凭据，暂未实现）
    if not login_id and session_id:
        # TODO: 根据 session_id 从数据库查询用户的 OA 凭据
        pass

    # 尝试导入 getBanBiao（需要在同一台机器，且 getBanBiao.py 在 Python 路径中）
    try:
        import getBanBiao as gb

        ban = gb.get_banbiao_data(
            date_str,
            staff_name=None,
            login_id=login_id or None,
            password_plain=oa_password or None,
        )
    except ImportError:
        # getBanBiao 不可用时，返回提示
        result = {
            "status": "no_data",
            "date": date_str,
            "hint": ("getBanBiao 模块不可用。"
                      "请在 MuhugoChat 后端机器上部署 getBanBiao.py，"
                      "或在工具 endpoint 中使用 HTTP 模式（填写正确的 Flask 服务地址）。"),
            "tool_name": tool_name,
        }
        print(json.dumps(result, ensure_ascii=False, default=str))
        sys.exit(0)
    except Exception as e:
        result = {
            "status": "error",
            "date": date_str,
            "error": str(e),
            "tool_name": tool_name,
        }
        print(json.dumps(result, ensure_ascii=False, default=str))
        sys.exit(1)

    # 精简输出（只返回前端需要的部分）
    staff_list = (ban or {}).get("staffList", [])
    sales_plan = (ban or {}).get("salesPlan", {})
    predict = (ban or {}).get("predict", {})

    out = {
        "status": "ok",
        "date": date_str,
        "staff_count": len(staff_list),
        "staff_list": staff_list,
        "sales_plan": sales_plan,
        "predict": predict,
    }
    print(json.dumps(out, ensure_ascii=False, default=str))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback

        print(json.dumps(
            {"error": str(e), "traceback": traceback.format_exc()},
            ensure_ascii=False,
        ))
        sys.exit(1)
