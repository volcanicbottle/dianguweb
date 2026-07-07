/* 「用典」典故星图 —— 典故为主角：枢纽总览 / 典故⇄诗链式漫游 */
"use strict";

const GITHUB_REPO = "volcanicbottle/dianguweb";   // 详情栏报错区提交到该仓库 Issue；留空隐藏

const svg = d3.select("#canvas");
const gRoot = svg.append("g");
const gLinks = gRoot.append("g");
const gNodes = gRoot.append("g");

/* 版本号只写在 index.html 的 <script src="app.js?v=N"> 上，数据请求继承它，
   保证 JSON 与解析它的 JS 永不脱节；升级只改 index.html 一处 */
const VQ = (() => {
  const v = new URL(document.currentScript.src).searchParams.get("v");
  return v ? "?v=" + v : "";
})();

/* iOS Safari 对无显式尺寸属性的 SVG 只重绘初始区域，展开到区域外的内容不刷新；
   显式同步 width/height 属性（flex-basis 为 0%，不会反过来影响布局）。
   与 style.css 中 #canvas 的 translateZ(0) 是同一修复的两半 */
function sizeCanvas() {
  const [W, H] = dims();
  svg.attr("width", W).attr("height", H);
}
new ResizeObserver(sizeCanvas).observe(svg.node());
sizeCanvas();

const TAP_SLOP = 10;           // 手指点按有几像素抖动，超过此距离才算拖拽，否则吞掉 click
const K_MIN = 0.3, K_MAX = 4;  // 画布缩放范围，fitVisible 的缩小下限与此保持一致

const zoom = d3.zoom().scaleExtent([K_MIN, K_MAX]).clickDistance(TAP_SLOP)
  .on("start", () => clearTimeout(focusTimer))
  .on("zoom", (ev) => gRoot.attr("transform", ev.transform));
svg.call(zoom);

let GRAPH = null, DETAILS = null, sim = null;
let selectedId = null;
let anchorNode = null;            // 锚定的典故或诗人；null = 枢纽总览
const OVERVIEW_MIN = 3;               // 总览只放挂诗数≥此值的枢纽星（目录/搜索可达全部）
const HINT_HTML = `<p class="hint">点击典故星查看用它的诗；点击诗展开它的其他典故；「典故目录」与搜索可达全部典故。</p>`;

const nodeCache = new Map();          // id -> 节点对象（保留 x/y）
const adj = {
  poemsByAllusion: new Map(),         // a:i -> [p:j]
  allusionsByPoem: new Map(),         // p:j -> [a:i]
  poetByPoem: new Map(),              // p:j -> o:k
  poemsByPoet: new Map(),             // o:k -> [p:j]
};
const expanded = { allusions: new Set(), poems: new Set(), poets: new Set(),
                   pinned: new Set() };   // pinned：被搜索/列表点选强制上图的诗（大诗人截断之外）
const POET_CAP = 50;         // 大诗人锚定时图上最多画的诗数（按用典数取前 N；列表与搜索仍达全部）
let poetShown = POET_CAP;    // 「再显示」按钮可逐批加大
let nodesById = null;                 // id -> 图节点（O(1) 查找）
let overviewIds = null;               // 总览枢纽星 id 集（数据静态，只算一次）
let maxOverviewCount = 1;             // 总览节点最大用典数（大小按 √ 归一到此）
const OV_MINR = 22, OV_MAXR = 70;     // 总览气泡半径范围（仅总览生效；锚定后用原 radius）
                                      // 22 保证多数 3 字典名整放；70 让高频典明显撑大、拉开大小差

function pushTo(map, key, val) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(val);
}

Promise.all([
  fetch("data/graph.json" + VQ).then(r => { if (!r.ok) throw new Error("graph.json " + r.status); return r.json(); }),
  fetch("data/details.json" + VQ).then(r => { if (!r.ok) throw new Error("details.json " + r.status); return r.json(); }),
]).then(([g, d]) => {
  GRAPH = g;
  DETAILS = d;
  nodesById = new Map(g.nodes.map(n => [n.id, n]));
  const ovNodes = g.nodes.filter(n => n.type === "allusion" && n.count >= OVERVIEW_MIN);
  overviewIds = new Set(ovNodes.map(n => n.id));
  maxOverviewCount = Math.max(1, ...ovNodes.map(n => n.count));
  for (const e of g.edges) {
    if (e.source.startsWith("a:")) {
      pushTo(adj.poemsByAllusion, e.source, e.target);
      pushTo(adj.allusionsByPoem, e.target, e.source);
    } else {                                    // p: → o:
      adj.poetByPoem.set(e.source, e.target);
      pushTo(adj.poemsByPoet, e.target, e.source);
    }
  }
  buildSearchIndex();
  const target = parseHash();
  if (target) {
    openFromHash(target);        // 直达链接：#a:1 / #o:12 / #p:123 打开即定位
  } else {
    update();
    fitVisible();                // 总览团块比屏幕大，载入后缩放适配
  }
}).catch(err => {
  document.getElementById("panel-content").innerHTML =
    `<p class="hint">数据加载失败：${err}</p>`;
});

function isHub(d) { return d.type === "allusion" && d.count >= 2; }

/* 名字写在圆内、按大圆排布的节点（枢纽典故与诗人） */
function isCentered(d) { return isHub(d) || d.type === "poet"; }

/* 节点的图上邻居（按 id 前缀分派到对应邻接表） */
function neighbors(id) {
  if (id.startsWith("a:")) return adj.poemsByAllusion.get(id) || [];
  if (id.startsWith("o:")) return adj.poemsByPoet.get(id) || [];
  const o = adj.poetByPoem.get(id);
  return [...(adj.allusionsByPoem.get(id) || []), ...(o ? [o] : [])];
}

/* 画布尺寸 */
function dims() { return [svg.node().clientWidth, svg.node().clientHeight]; }

/* 节点显示名：去掉括号注释（全名在详情栏） */
function shortLabel(d) {
  return d.label.replace(/（[^）]*）/g, "").replace(/\s+/g, "") || d.label;
}

/* 可见性：总览=枢纽典故；锚定后迭代到不动点，支持 典→诗→典→诗 链式展开 */
function visibleIds() {
  const vis = new Set();
  if (!anchorNode) {
    for (const id of overviewIds) vis.add(id);
  } else if (anchorNode.startsWith("o:")) {
    vis.add(anchorNode);
    const poems = adj.poemsByPoet.get(anchorNode) || [];
    const shown = poems.length > poetShown
      ? [...poems].sort((a, b) => poemDeg(b) - poemDeg(a)).slice(0, poetShown)
      : poems;
    for (const p of shown) vis.add(p);
  } else {
    vis.add(anchorNode);
    for (const p of adj.poemsByAllusion.get(anchorNode) || []) vis.add(p);
  }
  for (const id of expanded.pinned) vis.add(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of expanded.allusions) {
      if (!vis.has(a)) continue;
      for (const p of adj.poemsByAllusion.get(a) || [])
        if (!vis.has(p)) { vis.add(p); changed = true; }
    }
    for (const p of expanded.poems) {
      if (!vis.has(p)) continue;
      for (const a of adj.allusionsByPoem.get(p) || [])
        if (!vis.has(a)) { vis.add(a); changed = true; }
    }
    for (const o of expanded.poets) {
      if (!vis.has(o)) continue;
      for (const p of adj.poemsByPoet.get(o) || [])
        if (!vis.has(p)) { vis.add(p); changed = true; }
    }
  }
  return vis;
}

function clearExploration() {
  expanded.allusions.clear();
  expanded.poems.clear();
  expanded.poets.clear();
  expanded.pinned.clear();
}

/* 诗的用典数（大诗人截断排序用） */
function poemDeg(p) { return (adj.allusionsByPoem.get(p) || []).length; }

/* ── URL 直达：#a:1/#o:12/#p:123 ↔ 当前锚定/选中，可分享可收藏 ── */
function parseHash() {
  const m = location.hash.match(/^#([aop]:\d+)$/);
  return m && nodesById.has(m[1]) ? m[1] : null;
}
function syncHash() {
  const want = selectedId || anchorNode || "";
  const cur = location.hash.replace(/^#/, "");
  if (cur === want) return;
  history.replaceState(null, "", want ? "#" + want : location.pathname + location.search);
}
/* 从链接进入：典故/诗人直接锚定（分享语义=看这个典/这个人），诗走 gotoNode */
function openFromHash(target) {
  if (target.startsWith("p:")) { gotoNode(target); return; }
  setAnchor(target);
  selectedId = target;
  (target.startsWith("o:") ? showPoet : showAllusion)(target);
  update();
  fitVisible();
}
window.addEventListener("hashchange", () => {
  const target = parseHash();
  if (target && target !== (selectedId || anchorNode)) openFromHash(target);
  else if (!location.hash && anchorNode) {
    setAnchor(null); selectedId = null;
    panel.innerHTML = HINT_HTML;
    update(); fitVisible();
  }
});

/* 位置指示：总览 › 锚定 › 选中项；前两级可点回退 */
const crumbEl = document.getElementById("crumb");
function crumbLabel(id) {
  const n = nodesById.get(id);
  return n ? (n.type === "allusion" ? shortLabel(n) : n.label) : id;
}
function renderCrumb() {
  const parts = [`<span class="crumb-link" data-crumb="root">总览</span>`];
  if (anchorNode)
    parts.push(`<span class="crumb-link" data-crumb="anchor">${esc(crumbLabel(anchorNode))}</span>`);
  if (selectedId && selectedId !== anchorNode)
    parts.push(`<span>${esc(crumbLabel(selectedId))}</span>`);
  crumbEl.innerHTML = parts.join(`<span class="crumb-sep">›</span>`);
  crumbEl.hidden = parts.length === 1;
}
crumbEl.addEventListener("click", (ev) => {
  const c = ev.target.dataset.crumb;
  if (c === "root") {
    setAnchor(null); selectedId = null;
    panel.innerHTML = HINT_HTML;
    update(); fitVisible();
  } else if (c === "anchor" && anchorNode) {
    clearExploration(); selectedId = anchorNode;
    if (anchorNode.startsWith("o:")) showPoet(anchorNode); else showAllusion(anchorNode);
    update(); fitVisible();
  }
});

function ensureCached(id) {
  if (!nodeCache.has(id)) {
    const n = nodesById.get(id);
    if (n) nodeCache.set(id, Object.assign({}, n, seedPosition(n)));
  }
  return nodeCache.get(id);
}

/* 进入/退出锚定：锚定的典故钉在画布中心 */
function setAnchor(id) {
  const prev = anchorNode && nodeCache.get(anchorNode);
  if (prev) { prev.fx = null; prev.fy = null; }
  anchorNode = id;
  poetShown = POET_CAP;
  clearExploration();
  if (id) {
    const n = ensureCached(id);
    if (n) {
      const [W, H] = dims();
      n.fx = W / 2; n.fy = H / 2;
    }
  }
  svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
}

/* 总览圆堆积：气泡大小只按用典数（√ 使面积∝用典数），不掺名字长度 */
function overviewRadius(count) {
  const lo = Math.sqrt(OVERVIEW_MIN), hi = Math.sqrt(maxOverviewCount);
  const t = hi > lo ? (Math.sqrt(count) - lo) / (hi - lo) : 0;
  return OV_MINR + (OV_MAXR - OV_MINR) * Math.max(0, Math.min(1, t));
}

function radius(d) {
  if (!anchorNode && isHub(d)) return overviewRadius(d.count);   // 总览：用量-大小
  if (isHub(d)) {                                                 // 锚定后：原逻辑
    const fit = shortLabel(d).length * 6 + 8;
    return Math.min(40, Math.max(12 + d.count * 2.5, fit));
  }
  if (d.type === "poet") return Math.min(24, Math.max(13, 8 + Math.sqrt(d.count) * 1.6));
  return d.type === "allusion" ? 6 : 5;
}

function update() {
  const vis = visibleIds();
  const nodes = [...vis].map(id => ensureCached(id)).filter(Boolean);
  const links = GRAPH.edges
    .filter(e => vis.has(e.source) && vis.has(e.target))
    .map(e => ({ source: e.source, target: e.target }));
  render(nodes, links);
  syncHash();
}

function render(nodes, links) {
  const [W, H] = dims();
  if (sim) sim.stop();
  const packing = !anchorNode;   // 总览=圆堆积；锚定=原力导向
  sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(90).strength(0.5))
    .force("charge", d3.forceManyBody().strength(d =>
      packing ? -8                                     // 总览：微弱斥力，圆间留小缝隙不紧贴
      : isHub(d) ? -60 - d.count * 8 : d.type === "poet" ? -60 : -30))
    .force("x", d3.forceX(W / 2).strength(packing ? 0.28 : 0.03))   // 总览：强向心，挤成团块
    .force("y", d3.forceY(H / 2).strength(packing ? 0.28 : 0.035))
    .force("collide", d3.forceCollide()
      .radius(d => packing ? radius(d) + 2                          // 总览：半径+2px 小缝隙
        : isCentered(d) ? radius(d) + 6 : Math.max(18, shortLabel(d).length * 5.5))
      .strength(1).iterations(2));
  sim.alpha(0.5);

  const link = gLinks.selectAll("line")
    .data(links, d => (d.source.id || d.source) + "|" + (d.target.id || d.target));
  link.exit().remove();
  const linkSel = link.enter().append("line").attr("class", "link").merge(link);
  /* 聚焦模式：有选中节点时，非其邻域的节点与连线变淡 */
  const focus = selectedId && nodes.some(n => n.id === selectedId)
    ? new Set([selectedId, ...neighbors(selectedId)]) : null;
  linkSel.classed("dim", d => {
    if (!focus) return false;
    const s = d.source.id || d.source, t = d.target.id || d.target;
    return !(focus.has(s) && focus.has(t));
  });

  const node = gNodes.selectAll("g.node").data(nodes, d => d.id);
  node.exit().remove();
  const enter = node.enter().append("g")
    .on("click", onNodeClick).call(dragger());
  enter.append("circle");
  enter.append("text");
  /* 半径与文字每次渲染都刷新（节点跨总览/锚定持续存在时也随上下文更新） */
  const nodeSel = enter.merge(node).attr("class", nodeClass)
    .classed("dim", d => focus && !focus.has(d.id));
  nodeSel.select("circle").attr("r", d => radius(d));
  nodeSel.select("text").attr("dy", d => isCentered(d) ? 0 : radius(d) + 12).each(setNodeLabel);
  renderCrumb();

  const draw = () => {
    linkSel
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    nodeSel.attr("transform", d => `translate(${d.x},${d.y})`);
  };
  sim.on("tick", draw);
  if (packing) {
    /* 总览：先在后台把团块跑稳再画出来，避免一堆气泡入场乱晃；
       预推后 alpha 已衰减到接近 0，内部计时器停转，故手动画一次定格 */
    sim.stop();
    for (let i = 0; i < 260; i++) sim.tick();
    draw();
  }
}

/* 节点文字：总览气泡固定字号+装不下截断「…」；其余（锚定枢纽/诗人）缩字号塞满 */
function setNodeLabel(d) {
  const el = d3.select(this);
  const label = d.type === "allusion" ? shortLabel(d) : d.label;
  if (!isCentered(d)) { el.text(label); return; }
  const r = radius(d);
  if (!anchorNode && isHub(d)) {
    const fs = Math.max(11, Math.min(16, Math.round(r * 0.4)));
    const fit = Math.max(1, Math.floor((2 * r - 6) / (fs + 0.5)));
    el.text(label.length > fit ? label.slice(0, Math.max(1, fit - 1)) + "…" : label)
      .attr("dominant-baseline", "central").attr("font-size", fs);
  } else {
    const fs = Math.min(12, Math.floor((2 * r - 8) / Math.max(1, label.length)));
    el.text(label).attr("dominant-baseline", "central").attr("font-size", Math.max(8, fs));
  }
}

function nodeClass(d) {
  let cls = "node " + d.type;
  if (isHub(d)) cls += " hub";
  if (d.id === anchorNode) cls += " anchor";
  if (d.id === selectedId) cls += " selected";
  return cls;
}

function toggle(set, id) { set.has(id) ? set.delete(id) : set.add(id); }

/* 可锚定节点（典故/诗人）的统一点击语义：无锚→锚定；点锚自己：有展开先收拢回
   锚定视图（一步步退），干净时才退回总览；点其他→链式展开 */
function anchorableClick(id, set, showFn) {
  if (!anchorNode) {
    setAnchor(id);
    selectedId = id;
    showFn(id);
  } else if (id === anchorNode) {
    if (expanded.allusions.size || expanded.poems.size || expanded.poets.size) {
      clearExploration();
      selectedId = id;
      showFn(id);
    } else {
      setAnchor(null);
      selectedId = null;
      panel.innerHTML = HINT_HTML;
    }
  } else {
    toggle(set, id);
    selectedId = id;
    showFn(id);
  }
}

function onNodeClick(ev, d) {
  if (d.type === "allusion") anchorableClick(d.id, expanded.allusions, showAllusion);
  else if (d.type === "poet") anchorableClick(d.id, expanded.poets, showPoet);
  else {
    toggle(expanded.poems, d.id);
    selectedId = d.id;
    showPoem(d.id);
  }
  update();
  fitVisible();
  revealPanel();
}

/* 首次出现的节点从哪里长出来：枢纽典故走金角螺线，其余从已缓存的邻居身旁绽放 */
let hubRankCache = null;
function hubRank(id) {
  if (!hubRankCache) {
    hubRankCache = new Map(
      GRAPH.nodes.filter(n => isHub(n))
        .sort((a, b) => b.count - a.count)
        .map((n, i) => [n.id, i]));
  }
  return hubRankCache.get(id) || 0;
}

function seedPosition(n) {
  const [W, H] = dims();
  const jitter = () => (Math.random() - 0.5) * 30;
  const near = neighbors(n.id).map(id => nodeCache.get(id)).find(Boolean);
  if (near) return { x: near.x + jitter(), y: near.y + jitter() };
  if (isHub(n)) {
    const i = hubRank(n.id);
    const angle = i * 2.39996;                     // 黄金角
    const r = 40 * Math.sqrt(i + 0.5);
    return { x: W / 2 + r * Math.cos(angle), y: H / 2 + r * Math.sin(angle) };
  }
  return { x: W / 2 + jitter() * 4, y: H / 2 + jitter() * 4 };
}

function dragger() {
  return d3.drag().clickDistance(TAP_SLOP)
    .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
    .on("end", (ev, d) => {
      if (!ev.active) sim.alphaTarget(0);
      if (d.id !== anchorNode) { d.fx = null; d.fy = null; }
    });
}

/* ── 详情栏 ── */
const panel = document.getElementById("panel-content");

/* 内容更新后把详情栏拉回视野（手机放大平移时在视野外；已可见则本身就是无操作） */
function revealPanel() {
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

/* 详情栏可点列表项与诗句小注 */
function gotoItem(id, label, extraHtml = "") {
  return `<p><span class="goto" data-goto="${id}">${esc(label)}</span>${extraHtml}</p>`;
}

function verseMeta(verse) {
  return verse ? `<br><span class="meta">“${esc(verse)}”</span>` : "";
}

function feedbackHtml(ctxLabel, ctxId) {
  if (!GITHUB_REPO) return "";
  return `<h3>报错</h3>` +
    `<textarea id="fb-text" rows="3" placeholder="发现错误？写下问题（错字、作者不对、释义有误…）"></textarea>` +
    `<button id="fb-send" type="button" data-ctx="${esc(ctxLabel)}" data-ctxid="${esc(ctxId)}">提交到 GitHub</button>`;
}

function showAllusion(id) {
  const a = DETAILS.allusions[id.slice(2)];
  if (!a) return;
  let html = `<h2>${esc(a.title)}</h2>`;
  const primary = a.sources.find(s => s.primary) || a.sources[0];
  const metaBits = [];
  if (primary) metaBits.push("出" + esc(primary.book));
  if (a.aliases.length) metaBits.push("别名：" + a.aliases.map(esc).join("、"));
  if (metaBits.length) html += `<p class="meta">${metaBits.join(" · ")}</p>`;

  if (a.explanation) {
    html += `<h3>释义</h3><p>${esc(a.explanation)}</p>`;
  }
  const withText = a.sources.filter(s => s.text);
  if (withText.length) {
    html += `<h3>出处原文</h3>`;
    for (const s of withText.slice(0, 3)) {
      html += `<blockquote>${esc(s.text)}<br>——${esc(s.book)}` +
              (s.author ? `（${esc(s.author)}）` : "") + `</blockquote>`;
    }
  }
  if (!a.explanation && !withText.length) {
    html += `<p class="hint">本条暂无释义与原文。</p>`;
  }
  html += `<h3>用它的诗（${a.poems.length}）</h3>`;
  for (const p of a.poems) {
    html += gotoItem("p:" + p.id, `${p.title} · ${p.poet}`, verseMeta(p.verse));
  }
  html += feedbackHtml("典故 · " + a.title, id);
  panel.innerHTML = html;
}

function showPoem(id) {
  const p = DETAILS.poems[id.slice(2)];
  if (!p) return;
  let body = esc(p.content);
  for (const u of p.usages) {
    if (!u.verse) continue;
    const target = esc(u.verse);
    if (body.includes(target)) {
      body = body.replace(target,
        () => `<mark class="verse" data-goto="a:${u.id}">${target}</mark>`);
    }
  }
  let html = `<h2>${esc(p.title)}</h2>` +
    `<p class="meta">${esc(p.poet)} · ${esc(p.dynasty)}</p>` +
    `<p class="poem-body">${body}</p>` +
    `<h3>本诗用典（${p.usages.length}）</h3>`;
  for (const u of p.usages) {
    html += gotoItem("a:" + u.id, u.title, verseMeta(u.verse));
  }
  html += feedbackHtml(`诗 · ${p.title}（${p.poet}）`, id);
  panel.innerHTML = html;
}

function showPoet(id) {
  const o = DETAILS.poets[id.slice(2)];
  if (!o) return;
  const capped = id === anchorNode && o.poems.length > poetShown;
  let html = `<h2>${esc(o.name)}</h2>` +
    `<p class="meta">${esc(o.dynasty)} · 有典之诗 ${o.poems.length} 首` +
    (capped ? `，图上先画用典最多的 ${poetShown} 首；列表与搜索可达全部，点选即上图` : "") +
    `</p>`;
  if (capped)
    html += `<button id="poet-more" type="button">图上再显示 ${POET_CAP} 首</button>`;
  if (o.poems.length > 30)
    html += `<input id="poet-filter" type="text" placeholder="输入诗题过滤…" aria-label="过滤诗题">`;
  html += `<div id="poet-list"></div>`;
  panel.innerHTML = html;
  const listEl = document.getElementById("poet-list");
  const renderList = (q) => {
    const hits = q ? o.poems.filter(p => p.title.includes(q)) : o.poems;
    listEl.innerHTML = hits.slice(0, 100).map(p => gotoItem("p:" + p.id, p.title)).join("") +
      (hits.length > 100 ? `<p class="hint">还有 ${hits.length - 100} 首，请输入过滤…</p>` : "");
  };
  renderList("");
  const filterEl = document.getElementById("poet-filter");
  if (filterEl) filterEl.addEventListener("input",
    debounce((ev) => renderList(ev.target.value.trim()), 120));
}

/* 典故目录：全部典故（按挂诗数降序），可过滤，点选直达 */
function showCatalog() {
  const items = GRAPH.nodes
    .filter(n => n.type === "allusion")
    .sort((x, y) => y.count - x.count || x.label.localeCompare(y.label, "zh"))
    .map(n => ({ id: n.id, title: n.label, count: n.count,
                 aliases: (DETAILS.allusions[n.id.slice(2)] || {}).aliases || [] }));
  panel.innerHTML =
    `<h2>典故目录</h2>` +
    `<p class="meta">共 ${items.length} 个 · 按挂诗数排序，点选上图</p>` +
    `<input id="catalog-filter" type="text" placeholder="输入典故名过滤…" aria-label="过滤典故">` +
    `<div id="catalog-list"></div>`;
  const listEl = document.getElementById("catalog-list");
  const renderList = (q) => {
    const hits = q
      ? items.filter(it => it.title.includes(q) || it.aliases.some(al => al.includes(q)))
      : items;
    listEl.innerHTML = hits.slice(0, 60).map(it =>
      gotoItem(it.id, it.title, `<span class="meta"> ${it.count} 首</span>`)).join("") +
      (hits.length > 60 ? `<p class="hint">还有 ${hits.length - 60} 条，请输入过滤…</p>` : "");
  };
  renderList("");
  document.getElementById("catalog-filter").addEventListener("input",
    debounce((ev) => renderList(ev.target.value.trim()), 120));
  revealPanel();
}
document.getElementById("catalog-btn").addEventListener("click", showCatalog);

/* 详情栏内跳转与报错 */
panel.addEventListener("click", (ev) => {
  if (ev.target.id === "poet-more") {
    poetShown += POET_CAP;
    update();
    fitVisible();
    if (anchorNode) showPoet(anchorNode);
    return;
  }
  if (ev.target.id === "fb-send") {
    const box = document.getElementById("fb-text");
    const text = box.value.trim().slice(0, 800);
    if (!text) { box.focus(); return; }
    const ctx = ev.target.dataset.ctx, ctxid = ev.target.dataset.ctxid;
    const title = encodeURIComponent(`【报错】${ctx}`);
    const body = encodeURIComponent(`条目：${ctx}（${ctxid}）\n\n问题描述：\n${text}`);
    window.open(`https://github.com/${GITHUB_REPO}/issues/new?title=${title}&body=${body}`, "_blank", "noopener");
    return;
  }
  const el = ev.target.closest("[data-goto]");
  if (el) gotoNode(el.dataset.goto);
});

function gotoNode(id) {
  if (id.startsWith("o:")) {
    if (!visibleIds().has(id)) setAnchor(id);
    showPoet(id);
  } else if (id.startsWith("a:")) {
    if (!visibleIds().has(id)) setAnchor(id);
    showAllusion(id);
  } else {
    if (!visibleIds().has(id)) {
      if (anchorNode) {
        expanded.pinned.add(id);            // 锚定中：截断之外的诗强制上图
      } else {
        const firstAllusion = (adj.allusionsByPoem.get(id) || [])[0];
        if (firstAllusion) setAnchor(firstAllusion);
      }
    }
    expanded.poems.add(id);
    showPoem(id);
  }
  selectedId = id;
  update();
  fitVisible();
  revealPanel();
}

/* 等布局稳定后，缩放视野装下全部可见节点（只缩小不放大），避免展开后跑出画布 */
let focusTimer = null;
/* 缩放视野装下全部可见节点。轮询等布局稳定（alpha 降下来）再 fit——
   小图（锚定）settle 快、总览大团块 settle 慢，都能等到排稳；用户交互（zoom start）会清掉轮询 */
function fitVisible() {
  clearTimeout(focusTimer);
  let waited = 0;
  const tryFit = () => {
    if (!sim) return;
    if (sim.alpha() > 0.06 && waited < 3200) {     // 未稳且未超时 → 继续等
      waited += 150;
      focusTimer = setTimeout(tryFit, 150);
      return;
    }
    const [W, H] = dims();
    const ns = sim.nodes(), pad = 60;
    const x0 = d3.min(ns, d => d.x) - pad, x1 = d3.max(ns, d => d.x) + pad;
    const y0 = d3.min(ns, d => d.y) - pad, y1 = d3.max(ns, d => d.y) + pad;
    const fitK = Math.min(W / (x1 - x0), H / (y1 - y0));
    const k = Math.max(K_MIN, Math.min(d3.zoomTransform(svg.node()).k, fitK));
    const t = d3.zoomIdentity
      .translate(W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k);
    svg.transition().duration(600).call(zoom.transform, t);
  };
  focusTimer = setTimeout(tryFit, 300);
}

/* ── 搜索（典故名 / 别名 / 诗名） ── */
let INDEX = [];

function buildSearchIndex() {
  INDEX = [];
  for (const [aid, a] of Object.entries(DETAILS.allusions)) {
    INDEX.push({ text: a.title, sub: "典故", kind: "allusion", id: "a:" + aid });
    for (const alias of a.aliases)
      INDEX.push({ text: alias, sub: "别名 · " + a.title, kind: "alias", id: "a:" + aid });
  }
  for (const [pid, p] of Object.entries(DETAILS.poems)) {
    INDEX.push({ text: p.title, sub: "诗 · " + p.poet, kind: "poem", id: "p:" + pid });
  }
  for (const [oid, o] of Object.entries(DETAILS.poets || {})) {
    INDEX.push({ text: o.name, sub: "诗人 · " + o.dynasty, kind: "poet", id: "o:" + oid });
  }
}

/* 搜索排序：诗人永远置顶；其余按 精确 > 前缀 > 包含，同级内 典故 > 别名 > 诗 */
const KIND_ORDER = { poet: 0, allusion: 1, alias: 2, poem: 3 };
function searchScore(e, q) {
  const m = e.text === q ? 0 : e.text.startsWith(q) ? 1 : 2;
  return e.kind === "poet" ? m : 10 + m * 10 + KIND_ORDER[e.kind];
}

const searchInput = document.getElementById("search");
const searchResults = document.getElementById("search-results");

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

searchInput.addEventListener("input", debounce(() => {
  const q = searchInput.value.trim();
  if (!q) { searchResults.hidden = true; return; }
  const scored = [];
  for (const e of INDEX)
    if (e.text.includes(q)) scored.push([searchScore(e, q), e]);
  const hits = scored.sort((a, b) => a[0] - b[0]).slice(0, 12).map(s => s[1]);
  if (!hits.length) { searchResults.hidden = true; return; }
  searchResults.innerHTML = hits.map((h, i) =>
    `<li data-i="${i}"${h.kind === "poet" ? ' class="poet-hit"' : ""}>${esc(h.text)}<span class="sub">${esc(h.sub)}</span></li>`).join("");
  searchResults.hidden = false;
  searchResults.querySelectorAll("li").forEach((li, i) => {
    li.addEventListener("click", () => {
      searchResults.hidden = true;
      searchInput.value = "";
      gotoNode(hits[i].id);
    });
  });
}, 120));

document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".search-wrap")) searchResults.hidden = true;
});

/* ── 回到初始 ── */
document.getElementById("reset").addEventListener("click", () => {
  setAnchor(null);
  selectedId = null;
  searchInput.value = "";
  panel.innerHTML = HINT_HTML;
  update(); fitVisible();
});
