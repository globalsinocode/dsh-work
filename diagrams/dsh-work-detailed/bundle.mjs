import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputFile = path.resolve(sourceDirectory, '../dsh-work-architecture-all-in-one.html');
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'manifest.json'), 'utf8'));
const navigation = {
  '00-overview': ['总览', '五层职责与 Agent 执行主线'],
  '01-presentation': ['01 展示层', '双端入口、任务对话、团队协作与人工发布'],
  '02-orchestration': ['02 编排层', '任务调度、权限预算、受控委派与等待恢复'],
  '03-configuration': ['03 配置管理', 'Agent、Skill、Tool、模型、MCP、知识与经验'],
  '04-execution': ['04 执行层', 'Runtime Adapter、DSH、模型工具调用与成果处理'],
  '05-infrastructure': ['05 基础设施', '部署、持久化、执行隔离、凭据与备份恢复']
};

if (manifest.diagrams.length !== 6) throw new Error('Expected one overview and five layer diagrams.');
const views = manifest.diagrams.map(item => {
  if (!navigation[item.slug]) throw new Error(`Unknown diagram: ${item.slug}`);
  const source = fs.readFileSync(path.join(sourceDirectory, `${item.slug}.html`));
  const spec = JSON.parse(fs.readFileSync(path.join(sourceDirectory, `${item.slug}.json`), 'utf8'));
  const encoded = source.toString('base64');
  if (!Buffer.from(encoded, 'base64').equals(source)) throw new Error(`Content mismatch: ${item.slug}`);
  return {
    id: item.slug,
    title: item.title,
    label: navigation[item.slug][0],
    description: navigation[item.slug][1],
    nodes: spec.nodes.length,
    edges: spec.edges.length,
    sources: spec.evidence.length,
    bytes: source.length,
    sha256: createHash('sha256').update(source).digest('hex'),
    html: encoded
  };
});

function startAtlas() {
  const navigationElement = document.getElementById('layer-tabs');
  const stage = document.getElementById('diagram-stage');
  const description = document.getElementById('view-description');
  const counts = document.getElementById('view-counts');
  const fallback = document.getElementById('loading-message');
  try {
    const views = JSON.parse(document.getElementById('embedded-diagrams').textContent);
    const byId = new Map(views.map(view => [view.id, view]));
    const buttons = new Map();
    const panels = new Map();
    let selectedId = null;

    function loadView(view, panel) {
      if (panel.firstElementChild) return;
      const iframe = document.createElement('iframe');
      iframe.title = view.title + ' · 交互式 SeeCode 架构图';
      iframe.setAttribute('aria-label', iframe.title);
      iframe.setAttribute('allow', 'clipboard-write');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      const bytes = Uint8Array.from(atob(view.html), value => value.charCodeAt(0));
      // Keep each original SeeCode document intact and isolate its DOM/styles.
      iframe.srcdoc = new TextDecoder('utf-8').decode(bytes);
      panel.appendChild(iframe);
    }

    function selectView(id, { focus = false, updateHash = true } = {}) {
      const view = byId.get(id) || views[0];
      if (view.id !== selectedId) {
        for (const item of views) {
          const active = item.id === view.id;
          const button = buttons.get(item.id);
          button.setAttribute('aria-selected', String(active));
          button.tabIndex = active ? 0 : -1;
          panels.get(item.id).hidden = !active;
        }
        selectedId = view.id;
        description.textContent = view.description;
        counts.textContent = `${view.nodes} 个模块 · ${view.edges} 条连接 · ${view.sources} 处源码依据`;
        document.title = `${view.label} · dsh-work 五层架构图集`;
        loadView(view, panels.get(view.id));
      }
      if (focus) {
        const button = buttons.get(view.id);
        button.focus({ preventScroll: true });
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      if (updateHash && location.hash !== '#' + view.id) location.hash = view.id;
    }

    for (const view of views) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'tab-' + view.id;
      button.textContent = view.label;
      button.dataset.view = view.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', 'panel-' + view.id);
      button.setAttribute('aria-selected', 'false');
      button.tabIndex = -1;
      button.addEventListener('click', () => selectView(view.id));
      buttons.set(view.id, button);
      navigationElement.appendChild(button);

      const panel = document.createElement('section');
      panel.id = 'panel-' + view.id;
      panel.className = 'diagram-panel';
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', button.id);
      panel.hidden = true;
      panels.set(view.id, panel);
      stage.appendChild(panel);
    }

    navigationElement.addEventListener('keydown', event => {
      const current = views.findIndex(view => buttons.get(view.id) === event.target);
      if (current < 0) return;
      let next;
      if (event.key === 'ArrowRight') next = (current + 1) % views.length;
      else if (event.key === 'ArrowLeft') next = (current - 1 + views.length) % views.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = views.length - 1;
      else return;
      event.preventDefault();
      selectView(views[next].id, { focus: true });
    });

    window.addEventListener('hashchange', () => selectView(location.hash.slice(1), { updateHash: false }));
    selectView(location.hash.slice(1), { updateHash: false });
    fallback.hidden = true;
  } catch (error) {
    fallback.hidden = false;
    fallback.textContent = '图集载入失败。请使用完整的 HTML 文件，并确认浏览器允许 JavaScript。';
    console.error('Architecture atlas could not start:', error);
  }
}

const bootstrap = `(${startAtlas.toString()})();`;
// Parse the new wrapper script without opening or executing a browser page.
new Script(bootstrap, { filename: 'architecture-atlas-bootstrap.js' });
const payload = JSON.stringify(views).replaceAll('<', '\\u003c');
const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="dsh-work 五层架构图集：系统总览，以及展示、编排、配置管理、执行和基础设施五层模块详图。">
  <meta name="referrer" content="no-referrer">
  <title>dsh-work · 五层架构图集</title>
  <style>
    :root { color-scheme: light; --ink:#101828; --muted:#667085; --blue:#3564e8; --green:#16825d; --line:#e4e7ec; --paper:#ffffff; }
    * { box-sizing:border-box; }
    html,body { margin:0; width:100%; height:100%; }
    body { color:var(--ink); background:var(--paper); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
    button { font:inherit; }
    [hidden] { display:none !important; }
    .atlas { height:100vh; height:100dvh; display:flex; flex-direction:column; overflow:hidden; }
    .masthead { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:17px 24px 14px; border-bottom:1px solid var(--line); flex:none; }
    .brand { display:flex; align-items:center; gap:11px; min-width:0; }
    .brand-mark { width:30px; height:30px; border:2px solid var(--blue); border-radius:9px; display:grid; grid-template-columns:repeat(2,5px); gap:3px; place-content:center; flex:none; }
    .brand-mark i { width:5px; height:5px; background:var(--blue); border-radius:1px; }
    .brand-mark i:last-child { background:var(--green); }
    h1 { font-size:18px; line-height:1.35; font-weight:650; margin:0; letter-spacing:-.3px; }
    .edition { color:var(--muted); font-size:12px; margin:3px 0 0; }
    .file-badge { color:var(--green); border:1px solid #c3e1d5; background:#f3faf6; border-radius:999px; padding:6px 11px; font-size:12px; white-space:nowrap; }
    .navigation { padding:10px 18px; display:flex; gap:5px; overflow:auto hidden; background:#f8fafc; border-bottom:1px solid var(--line); flex:none; scrollbar-width:thin; }
    .navigation button { border:1px solid transparent; border-radius:8px; background:transparent; color:#475467; padding:9px 15px; font-size:13px; font-weight:550; white-space:nowrap; cursor:pointer; flex:none; }
    .navigation button:hover { background:#eef2f7; color:var(--ink); }
    .navigation button[aria-selected="true"] { background:#fff; color:var(--blue); border-color:#cfd9fc; box-shadow:0 1px 3px #1018280a; }
    .navigation button:focus-visible { outline:3px solid #3564e855; outline-offset:2px; }
    .view-meta { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:9px 24px; border-bottom:1px solid var(--line); font-size:12px; color:var(--muted); flex:none; }
    .view-meta p { margin:0; line-height:1.5; }
    #view-description { color:#475467; }
    #view-counts { white-space:nowrap; font-variant-numeric:tabular-nums; }
    .stage { position:relative; flex:1; min-height:0; width:100%; }
    .diagram-panel { width:100%; height:100%; }
    iframe { display:block; width:100%; height:100%; border:0; background:#fff; }
    .loading { margin:40px auto; max-width:560px; padding:20px; color:var(--muted); text-align:center; line-height:1.7; }
    noscript { display:block; padding:20px; text-align:center; color:#b42318; }
    @media (max-width:700px) {
      .masthead { padding:13px 15px; gap:12px; }
      h1 { font-size:16px; }
      .brand-mark { width:27px; height:27px; }
      .file-badge { padding:5px 8px; font-size:11px; }
      .edition { font-size:11px; }
      .navigation { padding:8px 10px; }
      .navigation button { padding:9px 12px; }
      .view-meta { align-items:flex-start; padding:8px 15px; flex-direction:column; gap:2px; font-size:11px; }
    }
    @media (prefers-reduced-motion:reduce) { * { scroll-behavior:auto !important; } }
  </style>
</head>
<body>
  <div class="atlas">
    <header class="masthead">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <div><h1>dsh-work · 五层架构图集</h1><p class="edition">系统总览与五层模块详图</p></div>
      </div>
      <span class="file-badge">6 个视图 · 单文件</span>
    </header>
    <nav id="layer-tabs" class="navigation" role="tablist" aria-label="选择架构层级"></nav>
    <div class="view-meta" role="status" aria-live="polite" aria-atomic="true">
      <p id="view-description">正在载入架构图集…</p><p id="view-counts"></p>
    </div>
    <main id="diagram-stage" class="stage" aria-label="架构图查看区">
      <p id="loading-message" class="loading">正在载入内嵌的 SeeCode 架构图…</p>
      <noscript>此图集需要 JavaScript 才能切换层级和使用图表交互。</noscript>
    </main>
  </div>
  <script id="embedded-diagrams" type="application/json">${payload}</script>
  <script>${bootstrap}</script>
</body>
</html>
`;

fs.writeFileSync(outputFile, html);
const saved = fs.readFileSync(outputFile, 'utf8');
const embedded = JSON.parse(saved.match(/<script id="embedded-diagrams" type="application\/json">([\s\S]*?)<\/script>/)[1]);
for (const view of embedded) {
  const decoded = Buffer.from(view.html, 'base64');
  if (createHash('sha256').update(decoded).digest('hex') !== view.sha256) throw new Error(`Invalid embedded document: ${view.id}`);
  if (!decoded.equals(fs.readFileSync(path.join(sourceDirectory, `${view.id}.html`)))) throw new Error(`Changed document: ${view.id}`);
}
if (/<iframe\b[^>]*\bsrc\s*=/i.test(saved)) throw new Error('The bundle must not depend on linked diagram files.');
console.log(JSON.stringify({ output:outputFile, bytes:fs.statSync(outputFile).size, views:embedded.length, embeddedDocumentsVerified:true, wrapperScriptSyntax:'passed' }));
