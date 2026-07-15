# -*- coding: utf-8 -*-
"""
精简版 getBanBiao — 仅包含 get_banbiao_data() 及其依赖。
供 agent_scripts/ 内脚本通过 script:// 协议调用。
"""

import time
import re
import json
import requests
from bs4 import BeautifulSoup
from datetime import datetime as dt, date, timedelta
import threading
import os

# ---------- 简单内存缓存 ----------
class SimpleCache:
    def __init__(self, expiry_time=300):
        self.cache = {}
        self.expiry_time = expiry_time
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            if key in self.cache:
                timestamp, value = self.cache[key]
                if time.time() - timestamp < self.expiry_time:
                    return value
                else:
                    del self.cache[key]
        return None

    def set(self, key, value):
        with self.lock:
            self.cache[key] = (time.time(), value)


cache = SimpleCache(expiry_time=300)


# ---------- 员工级别映射 ----------
def _load_employee_levels():
    """从 emyloees.txt 加载姓名→级别映射"""
    # 查找 emyloees.txt：先在当前目录找，再找 data/ 子目录
    search_paths = [
        os.path.join(os.path.dirname(__file__), 'emyloees.txt'),
        os.path.join(os.path.dirname(__file__), 'data', 'emyloees.txt'),
        os.path.join(os.path.dirname(__file__), '..', 'data', 'emyloees.txt'),
    ]
    mapping = {}
    for path in search_paths:
        try:
            with open(path, encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    parts = line.split()
                    if len(parts) >= 2:
                        mapping[parts[0]] = parts[1]
            if mapping:
                break  # 找到了就停止
        except Exception:
            continue
    if not mapping:
        print(f"[getBanBiao] 警告: 未找到 emyloees.txt，搜索路径: {search_paths}")
    return mapping


EMPLOYEE_LEVELS = _load_employee_levels()


# ---------- 工具函数 ----------
def get_input_value(parent, name, method):
    tag = None
    if method == 'input':
        input_tag = parent.find(method, {'name': name})
        tag = input_tag.get('value') if input_tag else None
    elif method == 'select':
        select_tag = parent.find(method, {'name': name})
        if select_tag and select_tag.find('option', selected=True):
            tag = select_tag.find('option', selected=True).text.strip()
    return tag


# ---------- 登录 ----------
def login(login_id=None, password_plain=None, timeout=10):
    """登录系统并返回 (cookie_str, session)"""
    lid = login_id or os.environ.get("OA_LOGIN_ID", "1S00059")
    pwd = password_plain or os.environ.get("OA_PASSWORD", "saliya599")

    try:
        url = "https://www1.tastyqube.com.cn/TastyQube_SALIYA/LoginAction.do?fromAppId=H-01-01&companyCd=QPRUVM"
        payload = (
            f'loginId={lid}&password={pwd}&companyCd=QPRUVM&companyCd=QPRUVM'
            '&borwser=Browser%3A%20Google%20Chrome%2098.0.4758.102%20%20Ver%3A%5BMozilla%2F5.0%20(Windows%20NT%2010.0%3B%20Win64%3B%20x64)%20AppleWebKit%2F537.36%20(KHTML'
            '&borwser=null&borwserLng=zh-CN&borwserLng=null'
            '&context_path=%2FTastyQube_SALIYA&url_suffix=.do'
            '&list_start_index=&focus_name=&actionId=&conditionDisabled=true'
            '&hozona=&shopChangeFlg=false&entryItemEditState=true'
            '&searchConditionEditState=false&validtionError=false'
            '&screenAppId=H-01-01&screenId=H-01-01&screenName=LOGIN%E7%94%BB%E9%9D%A2'
        )
        headers = {
            'Accept': '*/*',
            'Host': 'www1.tastyqube.com.cn',
            'Connection': 'keep-alive',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
        session = requests.session()
        response = session.post(url, headers=headers, data=payload, timeout=timeout)
        cookies = response.cookies

        cookie_name = ''
        cookie_value = ''
        for cookie in cookies:
            cookie_name = cookie.name
            cookie_value = cookie.value

        cookie = f'{cookie_name}={cookie_value}'
        return cookie, session
    except Exception as e:
        print(f"登录失败: {str(e)}")
        raise e


# ---------- 核心：排班数据 ----------
def get_banbiao_data(date_str=None, staff_name=None):
    cache_key = f"banbiao_{date_str}_{staff_name if staff_name else 'all'}"
    cached_data = cache.get(cache_key)
    if cached_data:
        return cached_data

    try:
        timeout = 10
        cookie, session = login()

        url2 = "https://www1.tastyqube.com.cn/TastyQube_SALIYA/Kt01008shAction.do?fromAppId=D-01-08_SH&companyCd=QPRUVM"

        if date_str:
            view_date = date_str.replace('-', '')
        else:
            view_date = '20250730'

        payload = (
            f"tenpo_Cd=1000059&tenpo_Name=%28%E4%B8%8A%E6%B5%B7%29059_%E5%A2%A8%E7%8E%89%E5%8D%97%E8%B7%AF%E5%BA%97"
            f"&view_Date={view_date}&industry=&laborViewFlg=0&hopeViewFlg=1&realViewFlg=0&restViewFlg=0"
            f"&showTimeFlg=1&sort=0&timeViewS=&staffCd=&staffNm="
            f"&leftTitle1=4&leftTitle1Def=4&leftTitle2=2&leftTitle2Def=4"
            f"&leftTitle3=4&leftTitle3Def=4&rightWidth=420&rightWidthDef=420&rightTableWidth=657"
            f"&jsMsg=KTJS00133W%2C%E5%88%A0%E9%99%A4%E8%AF%A5%E8%BF%9B%E5%BA%A6%E6%9D%A1%E3%80%82++%E6%98%AF%E5%90%A6%E7%BB%A7%E7%BB%AD%EF%BC%9F"
            f"%3BKTJS00151W%2C%E8%AF%B7%E4%B8%8D%E8%A6%81%E6%B7%BB%E5%8A%A0%E9%87%8D%E5%A4%8D%E4%BA%BA%E5%91%98%E3%80%82"
            f"%3BKTJS00024I%2C%E5%88%86%E9%92%9F%E8%AF%B7%E4%BB%A5%EF%BC%91%EF%BC%95%E5%88%86%E4%B8%BA%E5%8D%95%E4%BD%8D%E8%BF%9B%E8%A1%8C%E8%BE%93%E5%85%A5%E3%80%82"
            f"%3BKTJS00025I%2C%E5%88%86%E9%92%9F%E8%AF%B7%E4%BB%A5%EF%BC%93%EF%BC%90%E5%88%86%E4%B8%BA%E5%8D%95%E4%BD%8D%E8%BF%9B%E8%A1%8C%E8%BE%93%E5%85%A5%E3%80%82"
            f"%3BKTJS00035I%2C%7B0%7D%E4%B8%8D%E6%98%AF%E5%9C%A8%E5%B7%A5%E4%BD%9C%E6%97%B6%E9%97%B4%E8%8C%83%E5%9B%B4%E5%86%85%E3%80%82"
            f"%3BKTJS00141E%2C%E6%97%A0%E6%B3%95%E6%9B%B4%E6%96%B0%E8%BF%87%E5%8E%BB%E7%9A%84%E6%95%B0%E6%8D%AE%E3%80%82"
            f"%3BKTJS00142E%2C%7B0%7D%E5%92%8C%7B1%7D%E7%9A%84%E5%A4%A7%E5%B0%8F%E5%85%B3%E7%B3%BB%E4%B8%8D%E6%AD%A3%E7%A1%AE%E3%80%82"
            f"%3BKTJS00143E%2C%7B0%7D%E6%98%AF%E5%BF%85%E9%A1%BB%E9%A1%B9%E7%9B%AE%E3%80%82"
            f"%3BKTJS00125I%2C%E5%B0%9A%E6%97%A0%E9%9C%80%E8%A7%A3%E9%99%A4%E7%9A%84%E6%8E%92%E7%8F%AD%E6%97%B6%E9%97%B4%E3%80%82"
            f"%3B&halfHourFlg=&color=&houjinCd=%2500000001%25&owner="
            f"&context_path=%2FTastyQube_SALIYA&url_suffix=.do"
            f"&list_start_index=&focus_name=&actionId=Review&conditionDisabled=false"
            f"&hozona=1&shopChangeFlg=false&entryItemEditState=false"
            f"&searchConditionEditState=false&validtionError=false"
            f"&screenAppId=D-01-08_SH&screenId=D-01-08_SH"
            f"&screenName=%E6%97%A5%E5%88%AB%E6%8E%92%E7%8F%AD%E7%99%BB%E5%BD%95%E5%8F%8A%E6%89%93%E5%8D%B0"
            f"&companyCd=QPRUVM"
        )

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Host': 'www1.tastyqube.com.cn',
            'Connection': 'keep-alive',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': 'https://www1.tastyqube.com.cn/TastyQube_SALIYA/Kt03002Action.do?fromAppId=D-03-02&companyCd=QPRUVM',
            'Cookie': cookie
        }

        response2 = session.post(url2, headers=headers, data=payload, timeout=timeout)
        html_content = response2.text
        soup = BeautifulSoup(html_content, 'html.parser')
        report_div = soup.find('div', {'id': 'content_part'})

        if not report_div:
            return {"error": "无法获取排班数据"}

        data = {
            "shopName": "(上海)059_墨玉南路店",
            "salesPlan": {},
            "predict": {},
            "staffList": []
        }

        # 销售计划（16小时：08~23）
        all_tr = report_div.find_all('tr')
        if len(all_tr) > 1:
            second_tr = all_tr[1]
            right_div = second_tr.find('div', {'id': 'rightTitle'})
            for i in range(16):
                hour = i + 8
                plan_tag = right_div.find('input', {'name': f'timeBeanList[{i}].plan'})
                predict_tag = right_div.find('input', {'name': f'timeBeanList[{i}].predict'})
                if plan_tag:
                    data["salesPlan"][str(hour)] = plan_tag.get("value") or "0"
                if predict_tag:
                    data["predict"][str(hour)] = predict_tag.get("value") or "0"

        # 员工排班
        left_div = report_div.find('div', {'id': 'leftDetail'})
        if left_div:
            all_staff_rows = left_div.find_all('tr')
            for i in range(len(all_staff_rows)):
                staff_row = left_div.find('tr', {'id': f'leftT1{i}'})
                if not staff_row:
                    continue

                level_val = get_input_value(staff_row, f'resultList[{i}].level', 'input')
                if not level_val:
                    level_input = staff_row.find('input', {'name': f'resultList[{i}].level'})
                    if level_input:
                        td = level_input.find_parent('td')
                        if td:
                            level_val = td.get_text(strip=True) or ''

                staff_nm_tmp = get_input_value(staff_row, f'resultList[{i}].staffNm', 'input') or ''
                if not level_val and staff_nm_tmp:
                    level_val = EMPLOYEE_LEVELS.get(staff_nm_tmp.strip(), '')

                staff_data = {
                    "staffCd": get_input_value(staff_row, f'resultList[{i}].staffCd', 'input'),
                    "staffNm": get_input_value(staff_row, f'resultList[{i}].staffNm', 'input'),
                    "level": level_val,
                    "industry": get_input_value(staff_row, f'resultList[{i}].industry', 'select'),
                    "laborTime": get_input_value(staff_row, f'resultList[{i}].laborTime', 'input'),
                    "shiftStart": get_input_value(staff_row, f'resultList[{i}].oldshiftStart', 'input'),
                    "shiftEnd": get_input_value(staff_row, f'resultList[{i}].oldshiftEnd', 'input'),
                    "restStart": get_input_value(staff_row, f'resultList[{i}].oldshiftRestStartT1', 'input'),
                    "restEnd": get_input_value(staff_row, f'resultList[{i}].oldshiftRestEndT1', 'input')
                }

                if staff_data["staffCd"] and staff_data["staffNm"]:
                    if staff_name is None or (staff_name and staff_data["staffNm"] and staff_name in staff_data["staffNm"]):
                        data["staffList"].append(staff_data)

        cache.set(cache_key, data)
        return data

    except requests.exceptions.Timeout:
        return {"error": "请求超时，请稍后重试"}
    except requests.exceptions.ConnectionError:
        return {"error": "连接错误，请检查网络"}
    except Exception as e:
        return {"error": str(e)}
