import json, sys, urllib.request

data = json.loads(urllib.request.urlopen("http://127.0.0.1:8000/api/tasks").read())
for t in data:
    st = t.get("status", "?")
    logs = t.get("logs", [])
    print(f"{t['id'][:15]} status={st} logs_count={len(logs)} commit={len(t.get('commit_history',[]))}")
    for l in logs[-5:]:
        print(f"  [{l.get('agent','?')}] {l.get('level','')}: {l.get('message','')[:80]}")
