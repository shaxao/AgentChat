#!/usr/bin/env python3
"""
skill_runner.py — Coze-style auto-install wrapper for skill scripts.

两层依赖管理方案：
  第一层：服务器预装常用库（pandas, numpy, requests 等）
  第二层：运行时按需自动安装 — AST 预扫描 + ImportError 兜底

用法（由 Java ProcessBuilder 调用）：
  python3 skill_runner.py --script /path/to/user_script.py < stdin.json

协议（与现有 executeScriptTool 完全兼容）：
  - stdin: JSON {"tool_name":"xxx","arguments":{...},"session_id":"xxx"}
  - stdout: JSON 结果
  - stderr: 安装进度日志

设计参考：Coze（扣子）脚本执行方案
"""

import sys
import os
import subprocess
import json
import argparse
import ast
import re

# ── Import name → pip package name 映射表 ──
IMPORT_TO_PIP = {
    'PIL': 'Pillow',
    'cv2': 'opencv-python',
    'fitz': 'PyMuPDF',
    'sklearn': 'scikit-learn',
    'scipy': 'scipy',
    'matplotlib': 'matplotlib',
    'plotly': 'plotly',
    'torch': 'torch',
    'tensorflow': 'tensorflow',
    'transformers': 'transformers',
    'tiktoken': 'tiktoken',
    'bs4': 'beautifulsoup4',
    'lxml': 'lxml',
    'yaml': 'PyYAML',
    'dotenv': 'python-dotenv',
    'toml': 'toml',
    'pymysql': 'PyMySQL',
    'psycopg2': 'psycopg2-binary',
    'redis': 'redis',
    'sqlalchemy': 'SQLAlchemy',
    'httpx': 'httpx',
    'aiohttp': 'aiohttp',
    'websockets': 'websockets',
    'selenium': 'selenium',
    'docx': 'python-docx',
    'pptx': 'python-pptx',
    'pdfplumber': 'pdfplumber',
    'tabula': 'tabula-py',
    'pypdf': 'pypdf',
    'pypdf2': 'PyPDF2',
    'cryptography': 'cryptography',
    'bcrypt': 'bcrypt',
    'passlib': 'passlib',
    'openpyxl': 'openpyxl',
    'xlsxwriter': 'XlsxWriter',
    'xlrd': 'xlrd',
    'xlwt': 'xlwt',
    'markdown': 'Markdown',
    'jinja2': 'Jinja2',
    'dateutil': 'python-dateutil',
    'chardet': 'chardet',
    'certifi': 'certifi',
    'flask': 'Flask',
    'fastapi': 'fastapi',
    'pydantic': 'pydantic',
    'dash': 'dash',
    'streamlit': 'streamlit',
    'gradio': 'gradio',
    'celery': 'celery',
    'pytest': 'pytest',
    'qrcode': 'qrcode[pil]',
    'wordcloud': 'wordcloud',
    'numpy': 'numpy',
    'pandas': 'pandas',
    'requests': 'requests',
    'urllib3': 'urllib3',
    'Pillow': 'Pillow',
}

# ── Python 标准库模块（永远不 pip install）──
STDLIB_TOPLEVEL = frozenset({
    'abc', 'aifc', 'argparse', 'array', 'ast', 'asynchat', 'asyncio', 'asyncore',
    'atexit', 'audioop', 'base64', 'bdb', 'binascii', 'binhex', 'bisect', 'builtins',
    'bz2', 'calendar', 'cgi', 'cgitb', 'chunk', 'cmath', 'cmd', 'code', 'codecs',
    'codeop', 'collections', 'colorsys', 'compileall', 'concurrent', 'configparser',
    'contextlib', 'contextvars', 'copy', 'copyreg', 'cProfile', 'crypt', 'csv',
    'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib',
    'dis', 'distutils', 'doctest', 'email', 'encodings', 'enum', 'errno', 'faulthandler',
    'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'formatter', 'fractions', 'ftplib',
    'functools', 'gc', 'getopt', 'getpass', 'gettext', 'glob', 'grp', 'gzip',
    'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'imghdr',
    'imp', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword',
    'lib2to3', 'linecache', 'locale', 'logging', 'lzma', 'mailbox', 'mailcap',
    'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder', 'multiprocessing',
    'netrc', 'nis', 'nntplib', 'numbers', 'operator', 'optparse', 'os', 'ossaudiodev',
    'parser', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil',
    'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile',
    'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc', 'queue', 'quopri',
    'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy',
    'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil',
    'signal', 'site', 'smtpd', 'smtplib', 'sndhdr', 'socket', 'socketserver',
    'spwd', 'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'stringprep',
    'struct', 'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig', 'syslog',
    'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios', 'textwrap',
    'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'trace',
    'traceback', 'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing',
    'unicodedata', 'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings',
    'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib',
    'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib',
    '_thread', '_dummy_thread', '__future__',
})


def resolve_pip_name(import_name):
    """将 import 名映射为 pip package 名。"""
    top_level = import_name.split('.')[0]
    mapped = IMPORT_TO_PIP.get(top_level, IMPORT_TO_PIP.get(import_name))
    return mapped if mapped is not None else top_level


def is_stdlib(module_name):
    """判断模块是否属于 Python 标准库。"""
    top_level = module_name.split('.')[0]
    return top_level in STDLIB_TOPLEVEL or top_level in sys.builtin_module_names


def check_externally_managed():
    """检测是否需要 --break-system-packages。"""
    if sys.version_info < (3, 12):
        return False
    try:
        result = subprocess.run(
            [sys.executable, '-m', 'pip', 'install', '--dry-run', 'pip'],
            capture_output=True, text=True, timeout=10,
            env={**os.environ, 'PIP_REQUIRE_VIRTUALENV': 'false'}
        )
        return result.returncode != 0 and 'externally-managed-environment' in (result.stderr or '')
    except Exception:
        return False


def try_pip_install(import_name, use_break, max_retries=3):
    """尝试 pip install 缺失的包，返回是否成功。"""
    pip_name = resolve_pip_name(import_name)

    # 检查是否已安装（缓存检查）
    try:
        __import__(import_name.split('.')[0])
        return True
    except (ImportError, ModuleNotFoundError):
        pass

    for attempt in range(max_retries):
        cmd = [sys.executable, '-m', 'pip', 'install', pip_name,
               '-q', '--disable-pip-version-check']
        if use_break:
            cmd.append('--break-system-packages')

        try:
            subprocess_env = os.environ.copy()
            subprocess_env['PIP_REQUIRE_VIRTUALENV'] = 'false'
            subprocess_env.pop('PIP_USER', None)

            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=120,
                env=subprocess_env
            )

            if result.returncode == 0:
                try:
                    __import__(import_name.split('.')[0])
                    print(f"[skill_runner] ✓ 已安装: {pip_name}", file=sys.stderr)
                    return True
                except (ImportError, ModuleNotFoundError):
                    print(f"[skill_runner] ⚠ pip 报告成功但 import 仍失败: {pip_name}",
                          file=sys.stderr)

            stderr_tail = (result.stderr or '').strip()[-300:]
            print(f"[skill_runner] ✗ 安装失败 ({attempt+1}/{max_retries}): {pip_name}",
                  file=sys.stderr)
            if stderr_tail:
                print(f"[skill_runner]   错误: {stderr_tail}", file=sys.stderr)

        except subprocess.TimeoutExpired:
            print(f"[skill_runner] ⏱ 安装超时 ({attempt+1}/{max_retries}): {pip_name}",
                  file=sys.stderr)
        except Exception as e:
            print(f"[skill_runner] ✗ 安装异常 ({attempt+1}/{max_retries}): {pip_name} - {e}",
                  file=sys.stderr)

    return False


class ImportScanner(ast.NodeVisitor):
    """AST 访问器：提取所有 import 语句中的顶层模块名。"""

    def __init__(self):
        self.imports = set()

    def visit_Import(self, node):
        for alias in node.names:
            self.imports.add(alias.name.split('.')[0])
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module:
            self.imports.add(node.module.split('.')[0])
        self.generic_visit(node)


def scan_imports(source_code):
    """
    通过 AST 预扫描脚本中所有的 import 语句，
    返回顶层模块名的集合。
    """
    try:
        tree = ast.parse(source_code)
        scanner = ImportScanner()
        scanner.visit(tree)
        return scanner.imports
    except SyntaxError as e:
        print(f"[skill_runner] ⚠ AST 解析失败（可能含语法错误）: {e}", file=sys.stderr)
        return set()


def preinstall_missing_modules(script_path):
    """
    预扫描脚本的 import 语句，安装缺失的第三方模块。
    返回已安装的模块数。
    """
    try:
        with open(script_path, 'r', encoding='utf-8') as f:
            source_code = f.read()
    except Exception as e:
        print(f"[skill_runner] ⚠ 无法读取脚本: {e}", file=sys.stderr)
        return 0

    imports = scan_imports(source_code)
    if not imports:
        return 0

    use_break = check_externally_managed()
    installed_count = 0

    for module_name in sorted(imports):
        if is_stdlib(module_name):
            continue

        # 检查是否已安装
        try:
            __import__(module_name)
            continue
        except (ImportError, ModuleNotFoundError):
            pass

        print(f"[skill_runner] 🔍 预扫描发现缺失模块: {module_name}", file=sys.stderr)
        if try_pip_install(module_name, use_break):
            installed_count += 1

    return installed_count


def run_script(script_path, stdin_data_str, timeout=300):
    """
    执行用户脚本并返回 (exit_code, stdout, stderr)。
    通过 stdin 传递 JSON 参数（与现有协议兼容）。
    stdout 和 stderr 分离返回，避免安装日志混入 JSON 输出。
    """
    env = os.environ.copy()
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'
    env['PIP_REQUIRE_VIRTUALENV'] = 'false'

    try:
        proc = subprocess.run(
            [sys.executable, script_path],
            input=stdin_data_str,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env
        )

        stdout = proc.stdout.strip() if proc.stdout else ''
        stderr = proc.stderr.strip() if proc.stderr else ''
        return proc.returncode, stdout, stderr

    except subprocess.TimeoutExpired:
        return -1, '', f"脚本执行超时（超过 {timeout} 秒）"
    except Exception as e:
        return -1, '', f"脚本执行异常: {e}"


def extract_import_error(output_text):
    """从错误输出中提取缺失的模块名（ImportError/ModuleNotFoundError）。"""
    if not output_text:
        return None

    match = re.search(r"No module named '([^']+)'", output_text)
    if match:
        return match.group(1)

    match = re.search(r"cannot import name '[^']*' from '([^']+)'", output_text)
    if match:
        return match.group(1)

    return None


def main():
    parser = argparse.ArgumentParser(
        description='Skill script runner with auto-install (Coze-style)'
    )
    parser.add_argument('--script', required=True,
                        help='Path to the user skill script')
    args = parser.parse_args()

    script_path = args.script

    if not os.path.isfile(script_path):
        error_msg = json.dumps({
            "error": f"脚本文件不存在: {script_path}",
            "tool_name": "unknown"
        }, ensure_ascii=False)
        print(error_msg)
        sys.exit(1)

    # 确保脚本目录在 sys.path 中
    script_dir = os.path.dirname(os.path.abspath(script_path))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    # ── Phase 1: AST 预扫描 — 安装缺失的模块 ──
    preinstall_missing_modules(script_path)

    # 读取 stdin 数据
    stdin_data_str = sys.stdin.read()

    # ── Phase 2: 执行脚本 ──
    exit_code, stdout_output, stderr_output = run_script(script_path, stdin_data_str)

    # ── Phase 3: ImportError 兜底 — 处理动态 import ──
    # 有些脚本可能在运行时动态 import（如 importlib.import_module()），
    # AST 预扫描无法捕获。此时通过 exit_code != 0 + 错误信息 兜底。
    max_retry_attempts = 3
    for attempt in range(max_retry_attempts):
        if exit_code == 0:
            break

        # 同时检查 stdout 和 stderr 中的 ImportError 信息
        combined_output = stdout_output + '\n' + stderr_output
        import_error_module = extract_import_error(combined_output)
        if not import_error_module:
            break

        if is_stdlib(import_error_module):
            print(f"[skill_runner] ⚠ '{import_error_module}' 是标准库模块", file=sys.stderr)
            break

        print(f"[skill_runner] 🔍 运行时检测到缺失模块: {import_error_module}", file=sys.stderr)

        use_break = check_externally_managed()
        if not try_pip_install(import_error_module, use_break):
            print(f"[skill_runner] ✗ 无法安装 {import_error_module}，放弃重试", file=sys.stderr)
            break

        exit_code, stdout_output, stderr_output = run_script(script_path, stdin_data_str)

    # ── 输出结果 ──
    # stdout 和 stderr 分离输出，避免安装日志混入 JSON 输出导致后端解析失败
    if stdout_output:
        sys.stdout.write(stdout_output + '\n')
    if stderr_output:
        sys.stderr.write(stderr_output + '\n')

    final_code = exit_code if exit_code >= 0 else 1
    sys.exit(final_code)


if __name__ == '__main__':
    main()
