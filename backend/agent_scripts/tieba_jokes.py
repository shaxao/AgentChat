import requests
import json
import re
import random

def fetch_tieba_jokes(keyword="段子", count=5):
    """
    从百度贴吧爬取热门段子
    
    Args:
        keyword (str): 贴吧名称，默认"段子"
        count (int): 返回段子数量，默认5
    
    Returns:
        str: JSON格式的段子列表，每个包含title、content和url字段
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    }
    
    url = f'https://tieba.baidu.com/f?kw={keyword}&ie=utf-8&pn=0'
    
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        resp.encoding = 'utf-8'
        html = resp.text
        
        # 提取帖子标题和链接：<a href="/p/123456" title="标题" ...>
        pattern = r'href="(/p/\d+)"[^>]*title="([^"]*)"'
        matches = re.findall(pattern, html)
        
        jokes = []
        seen_titles = set()
        
        for href, title in matches:
            title = title.strip()
            if title and title not in seen_titles and len(title) > 2:
                seen_titles.add(title)
                post_url = 'https://tieba.baidu.com' + href
                
                # 获取帖子详情
                content = ""
                try:
                    detail_resp = requests.get(post_url, headers=headers, timeout=10)
                    detail_resp.encoding = 'utf-8'
                    detail_html = detail_resp.text
                    
                    content_match = re.search(r'class="d_post_content[^"]*"[^>]*>([\s\S]*?)</div>', detail_html)
                    if content_match:
                        raw = content_match.group(1)
                        content = re.sub(r'<[^>]+>', '', raw)
                        content = re.sub(r'\s+', ' ', content).strip()[:300]
                except:
                    pass
                
                jokes.append({
                    "title": title,
                    "content": content if content else "（点链接看全文→）",
                    "url": post_url
                })
                
                if len(jokes) >= count:
                    break
        
        if not jokes:
            raise Exception("没有爬到帖子")
        
        return json.dumps(jokes[:count], ensure_ascii=False)
    
    except Exception as e:
        # 爬取失败时使用内置段子库，保证整蛊效果不中断
        fallback = [
            {"title": "今天看到一个招聘广告", "content": "招程序员，要求：精通各种语言。我去了，面试官问：'你精通哪些？'我说：'中文和英文，还会一点点广东话。'然后就没有然后了。", "url": ""},
            {"title": "现在的年轻人", "content": "嘴上说着躺平，背地里却在偷偷努力。就像我，天天说不想上班，结果每天都准时出现在公司门口等开门。", "url": ""},
            {"title": "刚学会做饭", "content": "做了个西红柿炒鸡蛋，西红柿是西红柿，鸡蛋是鸡蛋，它们就是不肯融合在一起，好像在搞分居。", "url": ""},
            {"title": "去面试，HR问我的缺点是什么", "content": "我说：太老实了，不会说谎。HR说：那你怎么证明你真的很老实？我：...我刚才说的缺点其实是编的。", "url": ""},
            {"title": "今天在公交车上", "content": "看到一个大哥在玩手机，突然他女朋友打电话来了，他说：'我在开会呢，等会打给你。'然后继续刷贴吧...", "url": ""},
        ]
        random.shuffle(fallback)
        return json.dumps(fallback[:count], ensure_ascii=False)
