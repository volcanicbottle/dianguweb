/* 「用典」典故星图 —— 典故为主角：枢纽总览 / 典故⇄诗链式漫游 */
"use strict";

const GITHUB_REPO = "";   // 填 "用户名/仓库名"（如 "peng/diangu"）后启用详情栏报错区；留空隐藏

const svg = d3.select("#canvas");
const gRoot = svg.append("g");
const gLinks = gRoot.append("g");
const gNodes = gRoot.append("g");

const zoom = d3.zoom().scaleExtent([0.3, 4])
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
const expanded = { allusions: new Set(), poems: new Set(), poets: new Set() };
let nodesById = null;                 // id -> 图节点（O(1) 查找）
let overviewIds = null;               // 总览枢纽星 id 集（数据静态，只算一次）

function pushTo(map, key, val) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(val);
}

Promise.all([
  fetch("data/graph.json").then(r => { if (!r.ok) throw new Error("graph.json " + r.status); return r.json(); }),
  fetch("data/details.json").then(r => { if (!r.ok) throw new Error("details.json " + r.status); return r.json(); }),
]).then(([g, d]) => {
  GRAPH = g;
  DETAILS = d;
  nodesById = new Map(g.nodes.map(n => [n.id, n]));
  overviewIds = new Set(g.nodes
    .filter(n => n.type === "allusion" && n.count >= OVERVIEW_MIN)
    .map(n => n.id));
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
  update();
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
    for (const p of adj.poemsByPoet.get(anchorNode) || []) vis.add(p);
  } else {
    vis.add(anchorNode);
    for (const p of adj.poemsByAllusion.get(anchorNode) || []) vis.add(p);
  }
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
}

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

function radius(d) {
  if (isHub(d)) {
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
}

function render(nodes, links) {
  const [W, H] = dims();
  if (sim) sim.stop();
  sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(90).strength(0.5))
    .force("charge", d3.forceManyBody().strength(d => isHub(d) ? -60 - d.count * 8 : d.type === "poet" ? -60 : -30))
    .force("x", d3.forceX(W / 2).strength(0.03))
    .force("y", d3.forceY(H / 2).strength(0.035))
    .force("collide", d3.forceCollide()
      .radius(d => isCentered(d) ? radius(d) + 6 : Math.max(18, shortLabel(d).length * 5.5))
      .strength(1).iterations(2));
  sim.alpha(0.5);

  const link = gLinks.selectAll("line")
    .data(links, d => (d.source.id || d.source) + "|" + (d.target.id || d.target));
  link.exit().remove();
  const linkSel = link.enter().append("line").attr("class", "link").merge(link);

  const node = gNodes.selectAll("g.node").data(nodes, d => d.id);
  node.exit().remove();
  const enter = node.enter().append("g").attr("class", "node")
    .on("click", onNodeClick).call(dragger());
  enter.append("circle").attr("r", d => radius(d));
  enter.append("text")
    .attr("dy", d => isCentered(d) ? 0 : radius(d) + 12)
    .each(function (d) {
      const el = d3.select(this);
      const label = d.type === "allusion" ? shortLabel(d) : d.label;
      el.text(label);
      if (isCentered(d)) {
        const r = radius(d);
        const fs = Math.min(12, Math.floor((2 * r - 8) / Math.max(1, label.length)));
        el.attr("dominant-baseline", "central").attr("font-size", Math.max(8, fs));
      }
    });
  const nodeSel = enter.merge(node).attr("class", nodeClass);

  sim.on("tick", () => {
    linkSel
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    nodeSel.attr("transform", d => `translate(${d.x},${d.y})`);
  });
}

function nodeClass(d) {
  let cls = "node " + d.type;
  if (isHub(d)) cls += " hub";
  if (d.id === anchorNode) cls += " anchor";
  if (d.id === selectedId) cls += " selected";
  return cls;
}

function toggle(set, id) { set.has(id) ? set.delete(id) : set.add(id); }

/* 可锚定节点（典故/诗人）的统一点击语义：锚定 / 点自己退出 / 链式展开 */
function anchorableClick(id, set, showFn) {
  if (!anchorNode) {
    setAnchor(id);
    selectedId = id;
    showFn(id);
  } else if (id === anchorNode) {
    setAnchor(null);
    selectedId = null;
    panel.innerHTML = HINT_HTML;
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
  return d3.drag()
    .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
    .on("end", (ev, d) => {
      if (!ev.active) sim.alphaTarget(0);
      if (d.id !== anchorNode) { d.fx = null; d.fy = null; }
    });
}

/* ── 详情栏 ── */
const panel = document.getElementById("panel-content");

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
  let html = `<h2>${esc(o.name)}</h2>` +
    `<p class="meta">${esc(o.dynasty)} · 图中有典之诗 ${o.poems.length} 首</p>`;
  for (const p of o.poems) {
    html += gotoItem("p:" + p.id, p.title);
  }
  panel.innerHTML = html;
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
}
document.getElementById("catalog-btn").addEventListener("click", showCatalog);

/* 详情栏内跳转与报错 */
panel.addEventListener("click", (ev) => {
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
      const firstAllusion = (adj.allusionsByPoem.get(id) || [])[0];
      if (firstAllusion) setAnchor(firstAllusion);
    }
    expanded.poems.add(id);
    showPoem(id);
  }
  selectedId = id;
  update();
  focusNode(id);
}

let focusTimer = null;
function focusNode(id) {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    const n = nodeCache.get(id);
    if (!n) return;
    const [W, H] = dims();
    const k = d3.zoomTransform(svg.node()).k;
    const t = d3.zoomIdentity.translate(W / 2 - k * n.x, H / 2 - k * n.y).scale(k);
    svg.transition().duration(600).call(zoom.transform, t);
  }, 700);
}

/* ── 搜索（典故名 / 别名 / 诗名） ── */
let INDEX = [];

function buildSearchIndex() {
  INDEX = [];
  for (const [aid, a] of Object.entries(DETAILS.allusions)) {
    INDEX.push({ text: a.title, sub: "典故", id: "a:" + aid });
    for (const alias of a.aliases)
      INDEX.push({ text: alias, sub: "别名 · " + a.title, id: "a:" + aid });
  }
  for (const [pid, p] of Object.entries(DETAILS.poems)) {
    INDEX.push({ text: p.title, sub: "诗 · " + p.poet, id: "p:" + pid });
  }
  for (const [oid, o] of Object.entries(DETAILS.poets || {})) {
    INDEX.push({ text: o.name, sub: "诗人 · " + o.dynasty, id: "o:" + oid });
  }
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
  const hits = INDEX.filter(e => e.text.includes(q)).slice(0, 12);
  if (!hits.length) { searchResults.hidden = true; return; }
  searchResults.innerHTML = hits.map((h, i) =>
    `<li data-i="${i}">${esc(h.text)}<span class="sub">${esc(h.sub)}</span></li>`).join("");
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
  update();
});
