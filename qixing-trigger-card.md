# 七星堆肥厂 · 跨端推送触发卡（可随身携带）

> **用途**：当你换了新对话框 / 手机端 / 上下文被压缩 / 聊天记录被删，新 AI 不认识"堆肥厂"时，把本卡**全文粘贴**给新 AI（或让它在你的长期记忆里读），它就能立刻执行「推 / 同步 / 发布 / 上云」。
> **本卡不依赖任何本地脚本或文件**——所有动作都用内联代码完成，只要新环境能联网 + 能跑 Python3 即可（WorkBuddy 全端默认支持）。

## 0. 前置条件
- GitHub 仓库：`Sevenstarr7/qixing-workstation`，分支 `main`
- GitHub Token（fine-grained，有 contents 写权限）：
  - 电脑端：`~/.workbuddy/skills/qixing-publish/token.txt`
  - **手机端：本卡不存明文 token。首次请在对话里提供一次**（说"token 是 xxx"），或把 token 存进手机端长期记忆。Token 形如 `github_pat_11...`
- 环境要求：能联网、能执行 Python3

## 1. 触发词
推 / 同步 / 发布 / 更新七星堆肥厂 / 堆肥厂内容 / 上云

## 2. 生成内容
- **检索**：用 WebSearch 拉**当天 / 近 3 天**真实热点，优先有讨论声量、被多家媒体或 KOL 覆盖的；**禁止编造事件和 URL**；无法核实的换成有真实来源的同主题。
- **feed.json（25 条）**：结构 `[{cat, items:[{t,s,link,tag}]}]`，5 类固定顺序：`AI` / `产品经理` / `电商` / `海外独立站` / `产品sense`，每类 5 条。
  - 每条 `t` 20–30 字；`s` **严格 300–400 字**，以**电商产品经理第一人称视角**写，提炼 insight（挑 1–2 个对产品/业务/增长/用户洞察最有启示的点，点明"为什么重要、对你意味着什么"），含真实数据/案例、有因果；`link` 真实可访问（`#` 仅当确无来源且单类 ≤1 条）；`tag` 2–4 个词用 `/` 分隔。
- **pet.json（10 条）**：结构 `[{t,s,link,tag}]`（直接数组，无 cat）。
  - 主方向优先（每条都算数）：老年犬关节保养 / 猫咪泌尿 / 老年猫犬日常护理·好物·注意事项；补足方向（凑满 10 条才用）：宠物保健品市场趋势 / 宠物内容渠道打法（抖音·小红书·B站·视频号）。二创基调科普+种草。`s` 同样 300–400 字，视角贴合"想入局宠物保健的创业者"。

## 3. 去重（重要）
- 基线 `history.json`（近 7 天 link+tag，不被 Pages 展示）。生成前先查近 7 天已覆盖链接/实体。
- 规则：URL 完全命中近 7 天 → **坚决不写**（HARD）；标题 tag 与近 7 天共享核心实体 → 降权（SOFT），默认不新增，有实质新进展才允许。
- 若环境无 `history.json`，跳过校验（首次或跨端无基线时允许），推后由下方逻辑重建基线。

## 4. 推送（内联 Python，跨端通用）
把生成的 `feed.json` / `pet.json` 写到当前目录，再跑：

```python
import base64, json, os, urllib.request
TOKEN = os.environ.get("TOKEN") or input("粘贴 GitHub Token: ").strip()
REPO = "Sevenstarr7/qixing-workstation"
today = "2026-08-07"   # 改成当天日期 YYYY-MM-DD
for fn in ["feed.json", "pet.json"]:
    with open(fn, encoding="utf-8") as f:
        content = f.read()
    # 1. GET sha
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/contents/{fn}",
        headers={"Authorization": f"token {TOKEN}",
                 "Accept": "application/vnd.github.v3+json"})
    meta = json.loads(urllib.request.urlopen(req, timeout=60).read())
    sha = meta["sha"]
    # 2. PUT base64
    b64 = base64.b64encode(content.encode()).decode()
    body = json.dumps({"message": f"data: update {fn} ({today})",
                       "content": b64, "sha": sha}).encode()
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/contents/{fn}",
        data=body,
        headers={"Authorization": f"token {TOKEN}",
                 "Accept": "application/vnd.github.v3+json",
                 "Content-Type": "application/json"},
        method="PUT")
    r = urllib.request.urlopen(req, timeout=60)
    print(fn, "->", json.loads(r.read()).get("commit", {}).get("sha", "?")[:8])
print("DONE")
```
（`history.json` 首次推送可省略；之后用同样逻辑把近 7 天 link+tag 合并写回。）

## 5. 部署 & 验证
- 推送后 **GitHub Actions 自动部署** 到 `https://sevenstarr7.github.io/qixing-workstation/`（约 1–2 分钟）。
- **必须 curl 线上实际内容比对标题**确认落地（不要只看"推送成功"）：
  ```bash
  curl -s https://sevenstarr7.github.io/qixing-workstation/feed.json | python3 -c "import sys,json;d=json.load(sys.stdin);print('条数',sum(len(c['items']) for c in d));print('首条',d[0]['items'][0]['t'])"
  ```

## 6. 质量底线
- 链接活率 ≥95%；内容贴合"电商 PM / 宠物创业者"身份；每条看完有收获；**绝不用弱模型浅层聚合**（必须由当前对话模型检索+撰写）。
- 优先选当周有热度、被多家覆盖的热点，避免过于冷门的长尾选题。
