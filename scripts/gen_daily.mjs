// 每日数据生成脚本（GitHub Actions 云端运行 / 本地可测）
// OpenAI 兼容接口，base_url / model / key 全部从环境变量读，不写死任何服务商。
// 输出：仓库根目录 feed.json（脑蛋白 5 类×5 条）+ pet.json（宠物拆 2 次×5 条，去重后最多 10 条）
// 架构：search 模型单次稳定出 3-5 条，故 feed 每类独立调用、pet 分两段调用，避免一次大 prompt 截断/吞类
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
        max_tokens: 8192,                 // 中文摘要要够长，search 模型一次出 8+ 条可能截断，给足
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

// 结构归一化：search-preview 模型经常不按 prompt 返回严格 JSON，可能返回：
//   - 单个 item 对象 {t,s,link,tag}（根本没数组）
//   - 单组对象 {cat, items:[...]}
//   - 数组但每个元素不是 {cat,items}（可能就是个扁平数组）
//   - 键值映射 {分类名: {items:[...]}, ...}
// 这里尽可能多救几种形状，最终要么返回正常数组，要么返 null。
function isItemShape(o) {
  return o && typeof o === 'object' && !Array.isArray(o) && (o.t !== undefined || o.s !== undefined);
}
function normalizeItems(flat) {
  // 从任何层级里把"长得像 item"的对象挑出来组成数组
  const out = [];
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== 'object') return;
    if (isItemShape(node)) { out.push(node); return; }
    // 否则继续下钻一个层级（避开循环引用）
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(flat);
  return out;
}
function normalizeFeed(x) {
  // 已经是 [{cat, items:[...]}, ...]
  if (Array.isArray(x) && x.length && Array.isArray(x[0]?.items)) return x;
  // 单组 {cat, items:[...]}
  if (x && typeof x === 'object' && !Array.isArray(x) && Array.isArray(x.items)) {
    return [{ cat: x.cat || '', items: x.items }];
  }
  // 键值映射 {AI: {items:[...]}, 电商: {items:[...]}, ...}
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    const groups = [];
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (v && typeof v === 'object' && Array.isArray(v.items)) {
        groups.push({ cat: v.cat || k, items: v.items });
      }
    }
    if (groups.length) return groups;
    // 兜底：扁平 item 数组 → 全部塞进一个"综合"组
    const items = normalizeItems(x);
    if (items.length) return [{ cat: '综合', items }];
  }
  return null;
}
function normalizePet(x) {
  // 数组：直接返回（哪怕元素不是全标准）
  if (Array.isArray(x)) {
    const items = x.filter(isItemShape);
    if (items.length) return items;
  }
  // 包了 items 字段
  if (x && typeof x === 'object' && !Array.isArray(x) && Array.isArray(x.items)) {
    return x.items.filter(isItemShape);
  }
  // 单条 item 对象
  if (isItemShape(x)) return [x];
  // 键值映射 {老年犬: [...], 猫咪泌尿: [...], ...}
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    const all = normalizeItems(x);
    if (all.length) return all;
  }
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

// 去重：按标题去重（避免 refill 补来的重复）
function dedupeItems(arr) {
  const seen = new Set();
  return (arr || []).filter((it) => {
    const key = (it?.t || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 一次 LLM 调用 → 归一化成 item 数组（适配 search 模型的单条/数组/键值映射形状）
async function genItems(system, user) {
  const { data, raw } = await callLLM(system, user);
  const items = normalizePet(data) || [];
  if (!items.length) console.log(`[warn] 该次返回为空 | 原文头200: ${String(raw).slice(0, 200)}`);
  return items;
}

// search-preview 单次最多稳定出 3-5 条；一类一次拿 5 条，不够 3 条自动补一次（去重合并）
async function genCategoryFeed(cat) {
  const sys = '你是资深科技/产品资讯编辑。严格规则：你的回复必须且只能是合法的 JSON 数组，禁止任何前缀/后缀文字、自然语言说明、markdown 围栏（```）、注释、代码块标签。严禁输出引用标记（如 [1]、[1]: url、[citation]）、脚注、来源列表、或 JSON 之外的任何附加内容。开头第一个字符必须是 [，结尾最后一个字符必须是 ]。若违反，整个回复作废。';
  const usr = `生成今天(${TODAY})的"${cat}"分类资讯 5 条。
每一条格式:{ "t": 标题(20-30字), "s": 摘要(280-420字,客观、有信息量、含数据或因果), "link": 真实可访问的 URL, "tag": 2-4 个关键词用/分隔 }。
要求：
1) link 必须填写你通过联网搜索实际检索到的真实网页 URL（来自搜索结果的来源链接），不要用训练记忆编造；若确实找不到可靠来源可填 "#"。
2) 内容围绕当天或近期真实发生的事件/趋势，禁止虚构未发生的事件。
【输出格式】严格只输出一个 JSON 数组，从 [ 开头、] 结尾，无任何其他字符：[{t,s,link,tag}, ...]`;
  let items = await genItems(sys, usr);
  if (items.length < 3) {
    console.log(`[refill] ${cat} 首批 ${items.length} 条，补一次`);
    const more = await genItems(sys, usr + '\n\n(补充：刚才没出够 5 条，请再给 5 条不同内容)');
    items = dedupeItems(items.concat(more)).slice(0, 5);
  }
  return { cat, items: items.slice(0, 5) };
}

// 宠物情报拆 2 次（每次 5 条），按赛道切分，合并去重
async function genPetSlice(hint) {
  const sys = '你是宠物行业内容编辑。严格规则：你的回复必须且只能是合法的 JSON 数组，禁止任何前缀/后缀文字、自然语言说明、markdown 围栏（```）、注释、代码块标签。严禁输出引用标记（如 [1]、[1]: url、[citation]）、脚注、来源列表、或 JSON 之外的任何附加内容。开头第一个字符必须是 [，结尾最后一个字符必须是 ]。若违反，整个回复作废。';
  const usr = `生成今天(${TODAY})的宠物内容情报 5 条，紧扣赛道：${hint}。
每一条格式:{ "t": 标题(18-28字), "s": 摘要(280-420字,客观、有数据或案例), "link": 真实可访问的 URL, "tag": 2-4 个关键词用/分隔 }。
要求：
1) link 必须填写你通过联网搜索实际检索到的真实网页 URL（来自搜索结果的来源链接），不要用训练记忆编造；若确实找不到可靠来源可填 "#"。
2) 内容有料、真实，别水。
【输出格式】严格只输出一个 JSON 数组，从 [ 开头、] 结尾，无任何其他字符：[{t,s,link,tag}, ...]`;
  let items = await genItems(sys, usr);
  if (items.length < 3) {
    console.log(`[refill] 宠物(${hint}) 首批 ${items.length} 条，补一次`);
    const more = await genItems(sys, usr + '\n\n(补充：刚才没出够 5 条，请再给 5 条不同内容)');
    items = dedupeItems(items.concat(more)).slice(0, 5);
  }
  return items.slice(0, 5);
}

async function main() {
  console.log(`[start] ${TODAY} | base=${BASE_URL} | model=${MODEL}`);

  // feed：5 个分类，每个分类单独一次调用拿 5 条（search 模型单次稳定上限约 3-5 条）
  const cats = ['AI', '电商', '产品经理', '跨境DTC', '产品sense'];
  const feed = [];
  for (const cat of cats) {
    const g = await genCategoryFeed(cat);
    feed.push(g);
    console.log(`[feed] ${cat}: ${g.items.length} 条`);
  }

  // pet：拆 2 次（每次 5 条），合计最多 10 条
  const petA = await genPetSlice('老年犬关节保养、猫咪泌尿、老年猫犬日常护理');
  const petB = await genPetSlice('宠物保健品市场趋势、宠物内容渠道(抖音/小红书/B站)');
  const pet = dedupeItems(petA.concat(petB));
  console.log(`[pet] ${pet.length} 条 (A=${petA.length} + B=${petB.length})`);

  // 兜底：若某块完全空（模型抽风），写空结构也不让整条 run 挂掉（明天覆盖）
  const feedTotal = feed.reduce((n, g) => n + g.items.length, 0);
  if (!feedTotal) console.log(`[warn] feed 全部为空，写入空结构`);
  if (!pet.length) console.log(`[warn] pet 全部为空，写入空结构`);

  console.log(`[ok] 生成 feed=${feed.length} 类(${feedTotal}条), pet=${pet.length} 条，开始校验链接…`);
  await validateLinks(feed);
  await validateLinks([{ items: pet }]);

  const deadFeed = feed.reduce((n, g) => n + g.items.filter((i) => i.link === '#').length, 0);
  const deadPet = pet.filter((i) => i.link === '#').length;
  const totalFeed = feed.reduce((n, g) => n + g.items.length, 0);
  console.log(`[link] feed 死链 ${deadFeed}/${totalFeed}, pet 死链 ${deadPet}/${pet.length}`);

  writeFileSync('feed.json', JSON.stringify(feed, null, 2) + '\n', 'utf8');
  writeFileSync('pet.json', JSON.stringify(pet, null, 2) + '\n', 'utf8');
  console.log('[done] 已写入 feed.json / pet.json');
}

main().catch((e) => {
  console.error('[fatal]', e.message);
  process.exit(1);
});
