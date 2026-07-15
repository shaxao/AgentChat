"""AutoCode S0/S1 smoke benchmark runner.

Run against a live AutoCode backend:

    python tests/autocode_benchmark.py --base-url http://127.0.0.1:8000 --user-id <id>

The runner creates small deterministic tasks, polls them to a terminal state,
and writes a compact report under `.autocode-benchmark/`.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


CASES = [
    {
        "id": "s0_api_test_cli",
        "title": "S0：API 接口测试 CLI",
        "project_type": "tool",
        "agent_types": ["backend"],
        "description": (
            "开发一个 Python 命令行 API 测试工具。支持读取 YAML 用例、发送 HTTP 请求、"
            "断言状态码和 JSON 字段、输出 JSON 报告。不要生成前端页面。"
        ),
        "expected_files_any": ["SCRIPT_CONTRACT.md", "api_test_tool", "api_tester"],
        "timeout_seconds": 1800,
    },
    {
        "id": "s1_todo_web",
        "title": "S1：待办事项 Web 小应用",
        "project_type": "nextjs",
        "agent_types": ["frontend"],
        "description": (
            "开发一个轻量待办事项 Web 应用，包含新增、完成、删除、筛选、响应式布局和本地存储。"
            "需要生成可预览的前端页面。"
        ),
        "expected_files_any": ["package.json", "src", "app", "pages"],
        "timeout_seconds": 2400,
    },
]


@dataclass
class CaseResult:
    case_id: str
    title: str
    task_id: str = ""
    status: str = "not_started"
    progress: int = 0
    duration_seconds: float = 0.0
    generated_files_count: int = 0
    review_passed: bool | None = None
    review_score: int | None = None
    error: str = ""


def request_json(method: str, url: str, headers: dict[str, str], body: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for key, value in headers.items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {raw}") from exc


def run_case(base_url: str, headers: dict[str, str], case: dict[str, Any]) -> CaseResult:
    started = time.time()
    result = CaseResult(case_id=case["id"], title=case["title"])
    try:
        task = request_json(
            "POST",
            f"{base_url}/api/tasks",
            headers,
            {
                "title": case["title"],
                "description": case["description"],
                "project_type": case["project_type"],
                "agent_types": case["agent_types"],
                "enable_smart_planning": True,
            },
        )
        result.task_id = str(task.get("id") or "")
        deadline = started + int(case.get("timeout_seconds") or 1800)
        while time.time() < deadline:
            status = request_json("GET", f"{base_url}/api/tasks/{result.task_id}/status", headers)
            result.status = str(status.get("status") or "")
            result.progress = int(status.get("progress") or 0)
            if result.status in {"completed", "failed", "cancelled"}:
                break
            time.sleep(5)

        detail = request_json("GET", f"{base_url}/api/tasks/{result.task_id}", headers)
        review = detail.get("review") or {}
        result.review_passed = review.get("passed") if isinstance(review, dict) else None
        result.review_score = review.get("score") if isinstance(review, dict) else None
        events = detail.get("events") or []
        changed = set()
        for event in events:
            payload = event.get("payload") or {}
            for file in payload.get("changed_files") or []:
                changed.add(str(file))
        result.generated_files_count = len(changed)
    except Exception as exc:
        result.status = "error"
        result.error = str(exc)
    finally:
        result.duration_seconds = round(time.time() - started, 2)
    return result


def write_report(results: list[CaseResult], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = [asdict(item) for item in results]
    (output_dir / "benchmark-report.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# AutoCode Benchmark Report", ""]
    for item in results:
        lines.extend([
            f"## {item.title}",
            "",
            f"- case: `{item.case_id}`",
            f"- task: `{item.task_id}`",
            f"- status: `{item.status}`",
            f"- progress: {item.progress}",
            f"- duration: {item.duration_seconds}s",
            f"- changed files: {item.generated_files_count}",
            f"- review: {item.review_passed} / {item.review_score}",
        ])
        if item.error:
            lines.append(f"- error: {item.error}")
        lines.append("")
    (output_dir / "benchmark-report.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--user-id", default="")
    parser.add_argument("--token", default="")
    parser.add_argument("--case", choices=[case["id"] for case in CASES], default=None)
    parser.add_argument("--output-dir", default=".autocode-benchmark")
    args = parser.parse_args()

    headers: dict[str, str] = {}
    if args.user_id:
        headers["X-User-Id"] = args.user_id
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"

    selected = [case for case in CASES if args.case in (None, case["id"])]
    results = [run_case(args.base_url.rstrip("/"), headers, case) for case in selected]
    write_report(results, Path(args.output_dir))
    failed = [item for item in results if item.status != "completed" or item.review_passed is False]
    print(json.dumps([asdict(item) for item in results], ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
