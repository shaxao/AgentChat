import time
import json
import threading
import urllib.parse
import requests
from bs4 import BeautifulSoup
from datetime import datetime as dt, timedelta

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

_default_oa_login = None
_default_oa_pwd = None

def set_default_oa_credentials(login_id=None, password_plain=None):
    global _default_oa_login, _default_oa_pwd
    _default_oa_login = login_id
    _default_oa_pwd = password_plain

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

def _tenpo_cd_from_login_id(login_id: str) -> str:
    if login_id and len(login_id) >= 3 and login_id[:2].upper() == '1S':
        return '10' + login_id[2:]
    return login_id or ''

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
        html = resp.text
        import re
        pattern = re.compile(r'var\s+\S+_Value\s*=\s*\[\s*\[\s*"(\([^\"]+)"')
        for m in pattern.finditer(html):
            candidate = m.group(1)
            end_pos = m.end()
            tail = html[end_pos:end_pos + 60]
            close_double = tail.find(']]')
            close_comma  = tail.find('],[')
            if close_double != -1 and (close_comma == -1 or close_double < close_comma):
                return candidate
        return ''
    except Exception:
        return ''

def login(timeout=10, login_id=None, password_plain=None):
    import urllib.parse
    if not login_id:
        login_id = _default_oa_login or '1S00059'
    if not password_plain:
        password_plain = _default_oa_pwd or 'saliya599'

    tenpo_cd = _tenpo_cd_from_login_id(login_id)
    tenpo_name = ''

    try:
        url = "https://www1.tastyqube.com.cn/TastyQube_SALIYA/LoginAction.do?fromAppId=H-01-01&companyCd=QPRUVM"
        encoded_pw = urllib.parse.quote(password_plain)
        payload = (
            f'loginId={urllib.parse.quote(login_id)}&password={encoded_pw}'
            '&fromAppId=H-01-01&companyCd=QPRUVM'
            '&borwser=Browser%3A%20Google%20Chrome%2098.0.4758.102%20%20Ver%3A%5BMozilla%2F5.0%20(Windows%20NT%2010.0%3B%20Win64%3B%20x64)%20AppleWebKit%2F537.36'
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

cache = SimpleCache(expiry_time=300)

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
        payload = f"tenpo_Cd={tenpo_cd}&tenpo_Name={encoded_tenpo_name}&view_Date={view_date}&industry=&laborViewFlg=0&hopeViewFlg=1&realViewFlg=0&restViewFlg=0&showTimeFlg=1&sort=0&timeViewS=&staffCd=&staffNm=&leftTitle1=4&leftTitle1Def=4&leftTitle2=2&leftTitle2Def=4&leftTitle3=4&leftTitle3Def=4&rightWidth=420&rightWidthDef=420&rightTableWidth=657&jsMsg=KTJS00133W%2C%E5%88%A0%E9%99%A4%E8%AF%A5%E8%BF%9B%E5%BA%A6%E6%9D%A1%E3%80%82++%E6%98%AF%E5%90%A6%E7%BB%A7%E7%BB%AD%EF%BC%9F%3BKTJS00151W%2C%E8%AF%B7%E4%B8%8D%E8%A6%81%E6%B7%BB%E5%8A%A0%E9%87%8D%E5%A4%8D%E4%BA%BA%E5%91%98%E3%80%82%3BKTJS00024I%2C%E5%88%86%E9%92%9F%E8%AF%B7%E4%BB%A5%EF%BC%91%EF%BC%95%E5%88%86%E4%B8%BA%E5%8D%95%E4%BD%8D%E8%BF%9B%E8%A1%8C%E8%BE%93%E5%85%A5%E3%80%82%3BKTJS00025I%2C%E5%88%86%E9%92%9F%E8%AF%B7%E4%BB%A5%EF%BC%93%EF%BC%90%E5%88%86%E4%B8%BA%E5%8D%95%E4%BD%8D%E8%BF%9B%E8%A1%8C%E8%BE%93%E5%85%A5%E3%80%82%3BKTJS00035I%2C%7B0%7D%E4%B8%8D%E6%98%AF%E5%9C%A8%E5%B7%A5%E4%BD%9C%E6%97%B6%E9%97%B4%E8%8C%83%E5%9B%B4%E5%86%85%E3%80%82%3BKTJS00141E%2C%E6%97%A0%E6%B3%95%E6%9B%B4%E6%96%B0%E8%BF%87%E5%8E%BB%E7%9A%84%E6%95%B0%E6%8D%AE%E3%80%82%3BKTJS00142E%2C%7B0%7D%E5%92%8C%7B1%7D%E7%9A%84%E5%A4%A7%E5%B0%8F%E5%85%B3%E7%B3%BB%E4%B8%8D%E6%AD%A3%E7%A1%AE%E3%80%82%3BKTJS00143E%2C%7B0%7D%E6%98%AF%E5%BF%85%E9%A1%BB%E9%A1%B9%E7%9B%AE%E3%80%82%3BKTJS00125I%2C%E5%B0%9A%E6%97%A0%E9%9C%80%E8%A7%A3%E9%99%A4%E7%9A%84%E6%8E%92%E7%8F%AD%E6%97%B6%E9%97%B4%E3%80%82%3B&halfHourFlg=&color=&houjinCd=%2500000001%25&owner=&context_path=%2FTastyQube_SALIYA&url_suffix=.do&list_start_index=&focus_name=&actionId=Review&conditionDisabled=false&hozona=1&shopChangeFlg=false&entryItemEditState=false&searchConditionEditState=false&validtionError=false&screenAppId=D-01-08_SH&screenId=D-01-08_SH&screenName=%E6%97%A5%E5%88%AB%E6%8E%92%E7%8F%AD%E7%99%BB%E5%BD%95%E5%8F%8A%E6%89%93%E5%8D%B0&companyCd=QPRUVM&borwser=Browser%3A+Google+Chrome+119.0.0.0++Ver%3A%5BMozilla%2F5.0+%28Windows+NT+10.0%3B+Win64%3B+x64%29+AppleWebKit%2F537.36+%28KHTML%2C+like+Gecko%29+Chrome%2F119.0.0.0+Safari%2F537.36%5D++OS%3AWindows+10++Language%3A&borwserLng=zh-CN"
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
                plan_tag = right_div.find('input', {'name': f'timeBeanList[{i}].plan'})
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
                        level_val = {}
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
