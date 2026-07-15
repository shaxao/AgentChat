import time
import re
import json
import requests
from bs4 import BeautifulSoup
import datetime
from datetime import timedelta, datetime as dt, date
import threading
import calendar
import urllib.parse
import os

# 简单的内存缓存实现
class SimpleCache:
    def __init__(self, expiry_time=300):  # 默认缓存5分钟
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

    def set_with_ttl(self, key, value, ttl):
        with self.lock:
            fake_time = time.time() - (self.expiry_time - ttl)
            self.cache[key] = (fake_time, value)

    def clear_prefix(self, prefix):
        with self.lock:
            keys = [k for k in self.cache if k.startswith(prefix)]
            for k in keys:
                del self.cache[k]

cache = SimpleCache(expiry_time=300)

# 从本地文件加载员工级别映射（姓名 -> 级别）
def _load_employee_levels():
    path = os.path.join(os.path.dirname(__file__), 'data', 'emyloees.txt')
    mapping = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                parts = line.split()
                if len(parts) >= 2:
                    mapping[parts[0]] = parts[1]
    except Exception as e:
        print(f"加载员工级别文件失败: {e}")
    return mapping

EMPLOYEE_LEVELS = _load_employee_levels()

def _get_employee_levels():
    return _load_employee_levels()

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

def _parse_tenpo_name_from_html(html: str) -> str:
    pattern = re.compile(
        r'var\s+\S+_Value\s*=\s*\[\s*\[\s*"(\([^\"]+)"',
    )
    for m in pattern.finditer(html):
        candidate = m.group(1)
        end_pos = m.end()
        tail = html[end_pos:end_pos + 60]
        close_double = tail.find(']]')
        close_comma  = tail.find('],[')
        if close_double != -1 and (close_comma == -1 or close_double < close_comma):
            return candidate
    return ''

def _fetch_tenpo_name_from_rqtop(session, tenpo_cd: str, timeout: int = 10) -> str:
    try:
        today = dt.today()
        start_date = today.strftime('%Y%m%d')
        end_date = start_date
        month_start_date = today.replace(day=1).strftime('%Y%m%d')
        next_month = today.replace(day=28) + timedelta(days=4)
        month_end_date = (next_month.replace(day=1) - timedelta(days=1)).strftime('%Y%m%d')

        url = (
            f"https://www1.tastyqube.com.cn/TastyQube_SALIYA/rqTop"
            f"?rpxName=TOP/top.rpx&kbn={tenpo_cd}"
            f"&startDate={start_date}&monthEndDate={month_end_date}"
            f"&monthStartDate={month_start_date}&endDate={end_date}"
        )
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Host': 'www1.tastyqube.com.cn',
            'Connection': 'keep-alive',
        }
        resp = session.get(url, headers=headers, timeout=timeout)
        name = _parse_tenpo_name_from_html(resp.text)
        return name
    except Exception as e:
        print(f"[_fetch_tenpo_name_from_rqtop] 获取店铺名失败: {e}")
        return ''

def _tenpo_cd_from_login_id(login_id: str) -> str:
    if login_id and len(login_id) >= 3 and login_id[:2].upper() == '1S':
        return '10' + login_id[2:]
    return login_id or ''

def login(timeout=10, login_id=None, password_plain=None):
    import urllib.parse
    if not login_id:
        login_id = '1S00059'
    if not password_plain:
        password_plain = 'saliya599'

    tenpo_cd = _tenpo_cd_from_login_id(login_id)
    tenpo_name = ''

    try:
        url = "https://www1.tastyqube.com.cn/TastyQube_SALIYA/LoginAction.do?fromAppId=H-01-01&companyCd=QPRUVM"
        encoded_pw = urllib.parse.quote(password_plain)
        payload = (
            f'loginId={urllib.parse.quote(login_id)}&password={encoded_pw}'
            '&fromAppId=H-01-01&companyCd=QPRUVM'
            '&borwser=Browser%3A%20Google%20Chrome%2098.0.4758.102%20%20Ver%3A%5BMozilla%2F5.0%20(Windows%20NT%2010.0%3B%20Win64%3B%20x64)%20AppleWebKit%2F537.36%20(KHTML'
            '&borwser=null&borwserLng=zh-CN&borwserLng=null'
            '&context_path=%2FTastyQube_SALIYA&url_suffix=.do&list_start_index=&focus_name=&actionId='
            '&conditionDisabled=true&hozona=&shopChangeFlg=false&entryItemEditState=true'
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

        tenpo_name = _fetch_tenpo_name_from_rqtop(session, tenpo_cd, timeout=timeout)

        cookie = f'{cookie_name}={cookie_value}'
        return cookie, session, tenpo_cd, tenpo_name
    except Exception as e:
        raise e

def get_banbiao_data(date_str=None, staff_name=None, login_id=None, password_plain=None):
    cred_key = f"{login_id or 'default'}"
    cache_key = f"banbiao_{date_str}_{staff_name if staff_name else 'all'}_{cred_key}"
    cached_data = cache.get(cache_key)
    if cached_data:
        return cached_data
    try:
        timeout = 10
        cookie, session, tenpo_cd, tenpo_name = login(timeout, login_id=login_id, password_plain=password_plain)
        encoded_tenpo_name = urllib.parse.quote(tenpo_name) if tenpo_name else '%28%E4%B8%8A%E6%B5%B7%29059_%E5%A2%A8%E7%8E%89%E5%8D%97%E8%B7%AF%E5%BA%97'
        url2 = "https://www1.tastyqube.com.cn/TastyQube_SALIYA/Kt01008shAction.do?fromAppId=D-01-08_SH&companyCd=QPRUVM"
        if date_str:
            view_date = date_str.replace('-','')
        else:
            view_date = '20250730'
        payload = f"tenpo_Cd={tenpo_cd}&tenpo_Name={encoded_tenpo_name}&view_Date={view_date}&industry=&laborViewFlg=0&hopeViewFlg=1&realViewFlg=0&restViewFlg=0&showTimeFlg=1&sort=0&timeViewS=&staffCd=&staffNm=&leftTitle1=4&leftTitle1Def=4&leftTitle2=2&leftTitle2Def=4&leftTitle3=4&leftTitle3Def=4&rightWidth=420&rightWidthDef=420&rightTableWidth=657&jsMsg=KTJS00133W%2C%E5%88%A0%E9%99%A4%E8%AF%A5%E8%BF%9B%E5%BA%A6%E6%9D%A1%E3%80%82++%E6%98%AF%E5%90%A6%E7%BB%A7%E7%BB%AD%EF%BC%9F%3BKTJS00151W%2C%E8%AF%B7%E4%B8%8D%E8%A6%81%E6%B7%BB%E5%8A%A0%E9%87%8D%E5%A4%8D%E4%BA%BA%E5%91%98%E3%80%82%3BKTJS00024I%2C%E5%88%86%E9%92%9F%E8%AF%B7%E4%BB%A5%EF%BC%91%EF%BC%95%E5%88%86%E4%B8%BA%E5%8D%95%E4%BD%8D%E8%BF%9B%E8%A1%8C%E8%BE%93%E5%85%A5%E3%80%82%3BKTJS00025I%2C%E5%88%86%E9%92%9F%E8%AF%B7%E4%BB%A5%EF%BC%93%EF%BC%90%E5%88%86%E4%B8%BA%E5%8D%95%E4%BD%8D%E8%BF%9B%E8%A1%8C%E8%BE%93%E5%85%A5%E3%80%82%3BKTJS00035I%2C%7B0%7D%E4%B8%8D%E6%98%AF%E5%9C%A8%E5%B7%A5%E4%BD%9C%E6%97%B6%E9%97%B4%E8%8C%83%E5%9B%B4%E5%86%85%E3%80%82%3BKTJS00141E%2C%E6%97%A0%E6%B3%95%E6%9B%B4%E6%96%B0%E8%BF%87%E5%8E%BB%E7%9A%84%E6%95%B0%E6%8D%AE%E3%80%82%3BKTJS00142E%2C%7B0%7D%E5%92%8C%7B1%7D%E7%9A%84%E5%A4%A7%E5%B0%8F%E5%85%B3%E7%B3%BB%E4%B8%8D%E6%AD%A3%E7%A1%AE%E3%80%82%3BKTJS00143E%2C%7B0%7D%E6%98%AF%E5%BF%85%E9%A1%BB%E9%A1%B9%E7%9B%AE%E3%80%82%3BKTJS00125I%2C%E5%B0%9A%E6%97%A0%E9%9C%80%E8%A7%A3%E9%99%A4%E7%9A%84%E6%8E%92%E7%8F%AD%E6%97%B6%E9%97%B4%E3%80%82%3B&halfHourFlg=&color=&houjinCd=%2500000001%25&owner=&context_path=%2FTastyQube_SALIYA&url_suffix=.do&list_start_index=&focus_name=&actionId=Review&conditionDisabled=false&hozona=1&shopChangeFlg=false&entryItemEditState=false&searchConditionEditState=false&validtionError=false&screenAppId=D-01-08_SH&screenId=D-01-08_SH&screenName=%E6%97%A5%E5%88%AB%E6%8E%92%E7%8F%AD%E7%99%BB%E5%BD%95%E5%8F%8A%E6%89%93%E5%8D%B0&companyCd=QPRUVM&borwser=Browser%3A+Google+Chrome+119.0.0.0++Ver%3A%5BMozilla%2F5.0+%28Windows+NT+10.0%3B+Win64%3B+x64%29+AppleWebKit%2F537.36+%28KHTML%2C+like+Gecko%29+Chrome%2F119.0.0.0+Safari%2F537.36%5D++OS%3AAndroid+6.0++Language%3A&borwserLng=zh-CN"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Host': 'www1.tastyqube.com.cn',
            'Connection': 'keep-alive',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': 'https://www1.tastyqube.com.cn/TastyQube_SALIYA/Kt03002Action.do?fromAppId=D-03-02&companyCd=QPRUVM'
        }

        response2 = session.post(url2, headers=headers, data=payload, timeout=timeout)
        html_content = response2.text
        soup = BeautifulSoup(html_content, 'html.parser')
        report_div = soup.find('div', {'id': 'content_part'})
        if not report_div:
            return {"error": "无法获取数据"}
        data = {
            "shopName": tenpo_name or "(上海)059_墨玉南路店",
            "salesPlan": {},
            "predict": {},
            "staffList": []
        }
        all_tr = report_div.find_all('tr')
        if len(all_tr) > 1:
            second_tr = all_tr[1]
            right_div = second_tr.find('div', {'id': 'rightTitle'})
            for i in range(16):
                hour = i + 8
                plan_tag    = right_div.find('input', {'name': f'timeBeanList[{i}].plan'})
                predict_tag = right_div.find('input', {'name': f'timeBeanList[{i}].predict'})
                if plan_tag:
                    data["salesPlan"][str(hour)] = plan_tag.get("value") or "0"
                if predict_tag:
                    data["predict"][str(hour)] = predict_tag.get("value") or "0"
        left_div = report_div.find('div', {'id': 'leftDetail'})
        if left_div:
            all_staff_rows = left_div.find_all('tr')
            for i in range(len(all_staff_rows)):
                staff_row = left_div.find('tr', {'id': f'leftT1{i}'})
                if staff_row:
                    level_val = get_input_value(staff_row, f'resultList[{i}].level', 'input')
                    if not level_val:
                        level_input = staff_row.find('input', {'name': f'resultList[{i}].level'})
                        if level_input:
                            td = level_input.find_parent('td')
                            if td:
                                level_val = td.get_text(strip=True) or ''
                    staff_nm_tmp = get_input_value(staff_row, f'resultList[{i}].staffNm', 'input') or ''
                    if not level_val and staff_nm_tmp:
                        level_val = _get_employee_levels().get(staff_nm_tmp.strip(), '')

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

def get_weekly_staff_schedule(staff_name=None, start_date=None):
    cache_key = f"weekly_{staff_name if staff_name else 'all'}_{start_date if start_date else 'today'}"
    cached_data = cache.get(cache_key)
    if cached_data:
        return cached_data
    try:
        if not start_date:
            today = dt.now()
            start_date = today.strftime('%Y-%m-%d')
        start_datetime = dt.strptime(start_date, '%Y-%m-%d')
        weekly_data = {
            "staff_name": staff_name if staff_name else "全部员工",
            "start_date": start_date,
            "daily_schedules": []
        }
        weekday_map = {0: "星期一", 1: "星期二", 2: "星期三", 3: "星期四", 4: "星期五", 5: "星期六", 6: "星期日"}
        dates = []
        for i in range(7):
            current_date = start_datetime + timedelta(days=i)
            date_str = current_date.strftime('%Y-%m-%d')
            dates.append((date_str, current_date.weekday()))
        daily_schedules = [None] * 7
        def fetch_daily_data(idx, date_info):
            date_str, weekday = date_info
            try:
                daily_data = get_banbiao_data(date_str, staff_name)
                if staff_name:
                    staff_data = None
                    if "staffList" in daily_data and daily_data["staffList"]:
                        staff_data = daily_data["staffList"][0]
                    daily_schedule = {
                        "date": date_str,
                        "weekday": weekday_map[weekday],
                        "schedule": staff_data if staff_data else {"message": "无排班数据"}
                    }
                else:
                    daily_schedule = {
                        "date": date_str,
                        "weekday": weekday_map[weekday],
                        "salesPlan": daily_data.get("salesPlan", {}),
                        "staffList": daily_data.get("staffList", [])
                    }
                return idx, daily_schedule
            except Exception as e:
                return idx, {"date": date_str, "weekday": weekday_map[weekday], "error": str(e)}
        with threading.ThreadPoolExecutor(max_workers=7) as executor:
            futures = [executor.submit(fetch_daily_data, i, date_info) for i, date_info in enumerate(dates)]
            for future in futures:
                idx, daily_schedule = future.result()
                daily_schedules[idx] = daily_schedule
        weekly_data["daily_schedules"] = daily_schedules
        cache.set(cache_key, weekly_data)
        return weekly_data
    except Exception as e:
        return {"error": str(e)}

def get_revenue():
    today = dt.today()
    start_date = today.strftime("%Y%m%d")
    end_date = start_date
    month_start_date = today.replace(day=1).strftime("%Y%m%d")
    next_month = today.replace(day=28) + timedelta(days=4)
    month_end_date = next_month.replace(day=1) - timedelta(days=1)
    month_end_date = month_end_date.strftime("%Y%m%d")
    cookie, session, tenpo_cd, _ = login(timeout=10)
    url = (
        f"https://www1.tastyqube.com.cn/TastyQube_SALIYA/rqTop"
        f"?rpxName=TOP/top.rpx&kbn={tenpo_cd}"
        f"&startDate={start_date}&monthEndDate={month_end_date}"
        f"&monthStartDate={month_start_date}&endDate={end_date}"
    )
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Host': 'www1.tastyqube.com.cn',
        'Connection': 'keep-alive',
        'Cookie': cookie,
    }
    response = session.get(url, headers=headers, timeout=10)
    html_content = response.text
    soup = BeautifulSoup(html_content, 'html.parser')
    report_div = soup.find('div', {'id': 'report1_reportDiv'})
    if report_div:
        table = report_div.find('table', {'id': 'report1'})
        if table:
            tr = table.find('tr', {'rn': '4'})
            if tr:
                script_tags = tr.find_all('script', {'type': 'text/javascript'})
                pattern = r'var id_\d+_value = \[(\d+)\];'
                found_values = []
                for script in script_tags:
                    match = re.search(pattern, script.string if script.string else "")
                    if match:
                        value = match.group(1)
                        found_values.append(value)
                if found_values:
                    return ", ".join(found_values)
                else:
                    return "未找到数字"
            else:
                return "未找到目标 tr"
        else:
            return "未找到 <table id='report1'>"
    else:
        return "未找到 <div id='report1_reportDiv'>"

def get_last_year_sales_for_date(date_str):
    try:
        target = dt.strptime(date_str, '%Y-%m-%d')
    except Exception:
        return None
    cache_key = f'uriage_{target.year}_{target.month:02d}'
    cached = cache.get(cache_key)
    if cached is not None:
        return cached.get(target.day)
    try:
        last_day = calendar.monthrange(target.year, target.month)[1]
        last_day_date = dt(target.year, target.month, last_day)
        date_ym = target.strftime('%Y%m')
        cal_ref = target.strftime('%Y%m%d')
        update_ymd = last_day_date.strftime('%Y/%m/%d')

        cookie, session, tenpo_cd, tenpo_name = login(timeout=15)
        url = 'https://www1.tastyqube.com.cn/TastyQube_SALIYA/Ke02009SHAction.do'
        params = {
            'dateYm': date_ym,
            'calRefDateYmd': cal_ref,
            'updateYmd': update_ymd,
            'fromAppId': 'A-02-09_SH',
            'companyCd': 'QPRUVM',
            'tenpo_Cd': tenpo_cd,
            'tenpo_Name': tenpo_name,
            'referenceTenpoNm': '',
            'monthSaleAmount': '0.00',
            'monthSaleAmountView': '',
            'updateYmdV': '',
            'entryFlg': '',
            'houjinCd': '00000001',
            'sankouTenpoCd': '',
            'uriageTani': '1000',
            'updateFlg': '0',
            'context_path': '/TastyQube_SALIYA',
            'url_suffix': '.do',
            'list_start_index': '',
            'focus_name': '',
            'actionId': 'Review',
            'conditionDisabled': 'false',
            'hozona': '1',
            'shopChangeFlg': 'false',
            'entryItemEditState': 'false',
            'searchConditionEditState': 'false',
            'validtionError': 'false',
            'screenAppId': 'A-02-09_SH',
            'screenId': 'A-02-09_SH',
            'screenName': '月度销售预算作成',
            'borwser': 'Browser: Google Chrome 146.0.0.0',
            'borwserLng': 'zh-CN',
        }
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-CN,zh;q=0.9',
        }
        resp = session.get(url, params=params, headers=headers, timeout=15, verify=False)
        soup = BeautifulSoup(resp.text, 'html.parser')
        day_map = {}
        for i in range(last_day):
            inp = soup.find('input', {'name': f'infoList[{i}].uriage'})
            if inp:
                val_str = inp.get('value', '') or ''
                try:
                    day_map[i + 1] = round(float(val_str) * 1000, 2) if val_str.strip() else None
                except ValueError:
                    day_map[i + 1] = None
            else:
                day_map[i + 1] = None
        cache.set_with_ttl(cache_key, day_map, ttl=3600)
        return day_map.get(target.day)
    except Exception as e:
        print(f'[get_last_year_sales_for_date] 获取去年销售额失败: {e}')
        return None
