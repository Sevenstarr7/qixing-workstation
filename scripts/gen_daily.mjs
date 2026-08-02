// 每日数据生成脚本（GitHub Actions 云端运行 / 本地可测）
// OpenAI 兼容接口，base_url / model / key 全部从环境变量读，不写死任何服务商。
// 输出：仓库根目录 feed.json（脑蛋白 5 类×3 条）+ pet.json（宠物 12 条）
import { writeFileSync } from 'node:fs';

const API_KEY = process.env.LLM_API_KEY || '';
const BASE_URL = (process.env.LLM_BASE_URL || 'https://yunwu.ai/v1').replace(/\/$/, '');
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const TODAY = new Date().toISOString().slice(0, 10);

if (!API_KEY) {
  console.log('[skip] 未检测到 LLM_API_KEY，跳过生成（本地 dry-run 模式）');
  process.exit(0);
}

async function callLLM(system, user, retries = 3) {
  // 兜底提取：模型可能返回 markdown 围栏、前后缀说明、甚至截断的 JSON，
  // 这里依次尝试：去围栏→贪心匹配 [..]→匹配 {..}→首尾切片。任一成功即返回。
  function extractArray(text) {
    const start = text.indexOf('[');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }
  function extractObject(text) {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
    return null;
  }
  function extractJSON(text) {
    const cleaned = String(text || '')
      .replace(/```json\s*/gi, '')
      .replace(/```/g, '')
      .trim();
    // 括号平衡提取：忽略 search 模型末尾的 [1]: {"url":...} 引用脚注
    const arr = extractArray(cleaned);
    if (arr) return JSON.parse(arr);
    const obj = extractObject(cleaned);
    if (obj) return JSON.parse(obj);
    throw new Error('响应中找不到合法 JSON');
  }

  for (let i = 0; i < retries; i++) {
    try {
      // search-preview 模型（如 gpt-4o-mini-search-preview）不接受自定义 temperature，
      // 传了会报 "Model incompatible request argument supplied: temperature"。
      // 它用默认 temperature=1，JSON 抖动略大，靠括号平衡提取+硬 prompt 约束兜底。
      const isSearchModel = /search/i.test(MODEL);
      const body = {
        model: MODEL,
        max_tokens: 4096,                 // 中文摘要要够长，默认 1024 不够
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      };
      if (!isSearchModel) body.temperature = 0.5;   // 普通 chat 模型降温度减少 JSON 抖
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      try {
        // 返回 {data, raw}，raw 用于归一化失败时附在错误信息里看清模型实际回了啥
        return { data: extractJSON(content), raw: content };
      } catch (parseErr) {
        throw new Error(`JSON 解析失败: ${parseErr.message} | 原文头200字: ${String(content).slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`[retry ${i + 1}/${retries}] LLM 调用失败: ${e.message}`);
      if (i === retries - 1) throw e;
    }
  }
}

// 结构归一化：search-preview 模型有时不严格按 prompt 返回数组，会给单对象或键值映射
function normalizeFeed(x) {
  if (Array.isArray(x)) {
    if (x.length && Array.isArray(x[0]?.items)) return x;
    return null;  // 数组但元素没 items 字段 → 形状不对
  }
  if (x && typeof x === 'object') {
    // 单对象 {cat, items:[...]}
    if (Array.isArray(x.items)) return [{ cat: x.cat || '', items: x.items }];
    // 键值映射 {AI: {items:[...]}, 电商: {items:[...]}, ...}
    const arr = [];
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (v && typeof v === 'object' && Array.isArray(v.items)) {
        arr.push({ cat: v.cat || k, items: v.items });
      }
    }
    if (arr.length) return arr;
  }
  return null;
}
function normalizePet(x) {
  if (Array.isArray(x)) {
    if (x.length && typeof x[0] === 'object' && (x[0].t !== undefined || x[0].s !== undefined)) return x;
    return null;
  }
  if (x && typeof x === 'object' && Array.isArray(x.items)) return x.items;
  return null;
}

// 链接可达性校验：DNS 失败/超时/404 → 置 '#'（App 不显示死链原文入口）
async function checkLink(url) {
  if (!url || !/^https?:\/\//.test(url)) return '#';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
    if (r.status === 404) return '#';
    if (r.status >= 500) return '#';
    if (r.status >= 400) {
      // 可能是站点拦截 HEAD，再用 GET 探一下
      r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
      if (r.status === 404 || r.status >= 500) return '#';
    }
    clearTimeout(t);
    return url;
  } catch {
    return '#';
  }
}

async function validateLinks(arr) {
  const tasks = [];
  const indexMap = [];
  const walk = (items) => {
    items.forEach((it) => {
      tasks.push(checkLink(it.link));
      indexMap.push(it);
    });
  };
  arr.forEach((g) => walk(g.items || []));
  const results = await Promise.all(tasks);
  results.forEach((link, i) => {
    indexMap[i].link = link;
  });
}

async function main() {
  console.log(`[start] ${TODAY} | base=${BASE_URL} | model=${MODEL}`);

  const feedSys = '你是资深科技/产品资讯编辑。严格规则：你的回复必须且只能是合法的 JSON 数组，禁止任何前缀/后缀文字、自然语言说明、markdown 围栏（```）、注释、代码块标签。严禁输出引用标记（如 [1]、[1]: url、[citation]）、脚注、来源列表、或 JSON 之外的任何附加内容。开头第一个字符必须是 [，结尾最后一个字符必须是 ]。若违反，整个回复作废。';
  const feedUser = `生成今天(${TODAY})的资讯，5 个分类 [AI, 电商, 产品经理, 跨境DTC, 产品sense]，每类 3 条，共 15 条。
每一条格式:{ "t": 标题(20-30字), "s": 摘要(280-420字,客观、有信息量、含数据或因果), "link": 真实可访问的 URL, "tag": 2-4 个关键词用/分隔 }。
要求：
1) link 必须填写你通过联网搜索实际检索到的真实网页 URL（来自搜索结果的来源链接），不要用训练记忆编造；若确实找不到可靠来源可填 "#"。
2) 内容围绕当天或近期真实发生的事件/趋势，禁止虚构未发生的事件。
【输出格式】严格只输出一个 JSON 数组，从 [ 开头、] 结尾，无任何其他字符：[{ "cat": "AI", "items": [ {t,s,link,tag}, ... ] }, ... ]`;

  const petSys = '你是宠物行业内容编辑。严格规则：你的回复必须且只能是合法的 JSON 数组，禁止任何前缀/后缀文字、自然语言说明、markdown 围栏（```）、注释、代码块标签。严禁输出引用标记（如 [1]、[1]: url、[citation]）、脚注、来源列表、或 JSON 之外的任何附加内容。开头第一个字符必须是 [，结尾最后一个字符必须是 ]。若违反，整个回复作废。';
  const petUser = `生成今天(${TODAY})的宠物内容情报 12 条，紧扣赛道：老年犬关节保养、猫咪泌尿、老年猫犬日常护理、宠物保健品市场趋势、宠物内容渠道(抖音/小红书/B站)。
每一条格式:{ "t": 标题(18-28字), "s": 摘要(280-420字,客观、有数据或案例), "link": 真实可访问的 URL, "tag": 2-4 个关键词用/分隔 }。
要求：
1) link 必须填写你通过联网搜索实际检索到的真实网页 URL（来自搜索结果的来源链接），不要用训练记忆编造；若确实找不到可靠来源可填 "#"。
2) 内容有料、真实，别水。
【输出格式】严格只输出一个 JSON 数组，从 [ 开头、] 结尾，无任何其他字符：[{t,s,link,tag}, ...]`;

  const { data: feedData, raw: feedRaw } = await callLLM(feedSys, feedUser);
  const { data: petData, raw: petRaw } = await callLLM(petSys, petUser);

  // 结构兜底+归一化：search-preview 模型常不按 prompt 返回数组（返回单对象/键值映射）
  const feed = normalizeFeed(feedData);
  if (!feed) throw new Error(`feed 归一化失败 | 类型=${typeof feedData}, isArray=${Array.isArray(feedData)}, keys=${feedData && typeof feedData === 'object' ? Object.keys(feedData).slice(0, 5).join(',') : 'n/a'} | 原文头300: ${String(feedRaw).slice(0, 300)}`);
  const pet = normalizePet(petData);
  if (!pet) throw new Error(`pet 归一化失败 | 类型=${typeof petData}, isArray=${Array.isArray(petData)} | 原文头300: ${String(petRaw).slice(0, 300)}`);

  console.log(`[ok] 生成 feed=${feed.length} 类, pet=${pet.length} 条，开始校验链接…`);
  await validateLinks(feed);
  await validateLinks([{ items: pet }]);

  const deadFeed = feed.reduce((n, g) => n + g.items.filter((i) => i.link === '#').length, 0);
  const deadPet = pet.filter((i) => i.link === '#').length;
  console.log(`[link] feed 死链 ${deadFeed}/${feed.length * 3}, pet 死链 ${deadPet}/${pet.length}`);

  writeFileSync('feed.json', JSON.stringify(feed, null, 2) + '\n', 'utf8');
  writeFileSync('pet.json', JSON.stringify(pet, null, 2) + '\n', 'utf8');
  console.log('[done] 已写入 feed.json / pet.json');
}

main().catch((e) => {
  console.error('[fatal]', e.message);
  process.exit(1);
});
