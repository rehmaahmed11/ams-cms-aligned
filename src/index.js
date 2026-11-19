/**
 * AMS CMS — Aligned
 * Cloudflare Worker + D1 (bcms) + KV (bcms)
 *
 * Routes:
 *   GET    /                        Admin UI
 *   GET    /api/health              Health check (D1 + KV status)
 *   GET    /api/stats               Content counts
 *   GET    /api/content             List content (KV-cached 60s)
 *   POST   /api/content             Create content
 *   GET    /api/content/:id         Get one item
 *   PUT    /api/content/:id         Update one item
 *   DELETE /api/content/:id         Delete one item
 *   GET    /api/settings            Get all settings (KV)
 *   PUT    /api/settings            Save settings (KV)
 *   POST   /api/cache/clear         Clear KV content cache
 *
 * Write protection: if ADMIN_TOKEN secret/var is set, POST/PUT/DELETE
 * require header:  Authorization: Bearer <ADMIN_TOKEN>
 */

const CACHE_KEY = "cache:content:list";
const CACHE_TTL = 60; // seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function isAuthorized(request, env) {
  const token = env.ADMIN_TOKEN;
  if (!token) return true; // no token configured → open (local dev)
  const header = request.headers.get("Authorization") || "";
  return header === `Bearer ${token}`;
}

function requireAuth(request, env) {
  if (!isAuthorized(request, env)) {
    return json({ error: "Unauthorized. Provide a valid ADMIN_TOKEN as Bearer token." }, 401);
  }
  return null;
}

async function kvGet(env, key) {
  try {
    if (!env.KV) return null;
    return await env.KV.get(key);
  } catch {
    return null; // KV not configured yet — don't crash the API
  }
}

async function kvPut(env, key, value, ttl) {
  try {
    if (!env.KV) return false;
    if (ttl) await env.KV.put(key, value, { expirationTtl: ttl });
    else await env.KV.put(key, value);
    return true;
  } catch {
    return false;
  }
}

async function kvDelete(env, key) {
  try {
    if (!env.KV) return false;
    await env.KV.delete(key);
    return true;
  } catch {
    return false;
  }
}

async function ensureSchema(env) {
  // Fallback so the API works even before migrations are applied.
  // NOTE: D1's exec() rejects multi-statement batches, so run each
  // statement individually via prepare().run().
  if (!env.DB) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'page',
      status TEXT NOT NULL DEFAULT 'draft',
      excerpt TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      cover_image TEXT NOT NULL DEFAULT '',
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ];
  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }
}

function parseMeta(row) {
  if (!row) return row;
  try { row.meta = row.meta ? JSON.parse(row.meta) : {}; } catch { row.meta = {}; }
  return row;
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function handleHealth(env) {
  let db = false, kv = false;
  try { if (env.DB) { await env.DB.prepare("SELECT 1").first(); db = true; } } catch {}
  try { if (env.KV) { await env.KV.get("health-check"); kv = true; } } catch {}
  return json({ ok: db, db, kv, database: "bcms", kv_namespace: "bcms", env: env.ENVIRONMENT || "production" });
}

async function handleStats(env) {
  await ensureSchema(env);
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM content").first();
  const published = await env.DB.prepare("SELECT COUNT(*) AS n FROM content WHERE status='published'").first();
  const byType = await env.DB.prepare("SELECT type, COUNT(*) AS n FROM content GROUP BY type").all();
  return json({ total: total?.n ?? 0, published: published?.n ?? 0, by_type: byType.results || [] });
}

async function listContent(env, url) {
  const status = url.searchParams.get("status");
  const type = url.searchParams.get("type");
  const cacheable = !status && !type;

  if (cacheable) {
    const cached = await kvGet(env, CACHE_KEY);
    if (cached) {
      try { return json({ data: JSON.parse(cached), cached: true }); } catch {}
    }
  }

  await ensureSchema(env);
  const conditions = [];
  const params = [];
  if (status) { conditions.push("status = ?"); params.push(status); }
  if (type) { conditions.push("type = ?"); params.push(type); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM content ${where} ORDER BY updated_at DESC LIMIT 200`
  ).bind(...params).all();

  const data = (results || []).map(parseMeta);
  if (cacheable) await kvPut(env, CACHE_KEY, JSON.stringify(data), CACHE_TTL);
  return json({ data, cached: false });
}

async function createContent(request, env) {
  const denied = requireAuth(request, env);
  if (denied) return denied;

  const input = await request.json().catch(() => ({}));
  const title = String(input.title || "").trim();
  if (!title) return json({ error: "title is required" }, 400);

  const slug = slugify(input.slug || title) || `item-${Date.now()}`;
  const type = ["page", "post"].includes(input.type) ? input.type : "page";
  const status = ["draft", "published"].includes(input.status) ? input.status : "draft";
  const meta = typeof input.meta === "string" ? input.meta : JSON.stringify(input.meta || {});

  await ensureSchema(env);
  try {
    const result = await env.DB.prepare(
      `INSERT INTO content (title, slug, type, status, excerpt, body, cover_image, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    ).bind(title, slug, type, status, String(input.excerpt || ""), String(input.body || ""), String(input.cover_image || ""), meta).first();

    await kvDelete(env, CACHE_KEY);
    return json({ data: parseMeta(result) }, 201);
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE")) return json({ error: `slug "${slug}" already exists` }, 409);
    throw e;
  }
}

async function getContent(env, id) {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT * FROM content WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "Not found" }, 404);
  return json({ data: parseMeta(row) });
}

async function updateContent(request, env, id) {
  const denied = requireAuth(request, env);
  if (denied) return denied;

  const input = await request.json().catch(() => ({}));
  await ensureSchema(env);

  const existing = await env.DB.prepare("SELECT * FROM content WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);

  const title = input.title !== undefined ? String(input.title).trim() : existing.title;
  if (!title) return json({ error: "title is required" }, 400);
  const slug = input.slug !== undefined ? slugify(input.slug) : existing.slug;
  const type = ["page", "post"].includes(input.type) ? input.type : existing.type;
  const status = ["draft", "published"].includes(input.status) ? input.status : existing.status;
  const meta = input.meta !== undefined
    ? (typeof input.meta === "string" ? input.meta : JSON.stringify(input.meta))
    : existing.meta;

  try {
    const result = await env.DB.prepare(
      `UPDATE content
       SET title=?, slug=?, type=?, status=?, excerpt=?, body=?, cover_image=?, meta=?,
           updated_at=datetime('now')
       WHERE id=? RETURNING *`
    ).bind(
      title, slug || existing.slug, type, status,
      input.excerpt !== undefined ? String(input.excerpt) : existing.excerpt,
      input.body !== undefined ? String(input.body) : existing.body,
      input.cover_image !== undefined ? String(input.cover_image) : existing.cover_image,
      meta, id
    ).first();

    await kvDelete(env, CACHE_KEY);
    return json({ data: parseMeta(result) });
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE")) return json({ error: `slug "${slug}" already exists` }, 409);
    throw e;
  }
}

async function deleteContent(request, env, id) {
  const denied = requireAuth(request, env);
  if (denied) return denied;

  await ensureSchema(env);
  const result = await env.DB.prepare("DELETE FROM content WHERE id = ? RETURNING id").bind(id).first();
  if (!result) return json({ error: "Not found" }, 404);
  await kvDelete(env, CACHE_KEY);
  return json({ ok: true, deleted: result.id });
}

async function getSettings(env) {
  const raw = await kvGet(env, "settings");
  if (raw) { try { return json({ data: JSON.parse(raw) }); } catch {} }
  // Fallback to D1 settings table
  try {
    await ensureSchema(env);
    const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
    const data = Object.fromEntries((results || []).map(r => [r.key, r.value]));
    return json({ data });
  } catch {
    return json({ data: {} });
  }
}

async function saveSettings(request, env) {
  const denied = requireAuth(request, env);
  if (denied) return denied;

  const input = await request.json().catch(() => ({}));
  const data = input.data && typeof input.data === "object" ? input.data : input;

  await kvPut(env, "settings", JSON.stringify(data));
  try {
    await ensureSchema(env);
    for (const [key, value] of Object.entries(data)) {
      await env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`
      ).bind(String(key), String(value)).run();
    }
  } catch {}
  return json({ data });
}

// ---------------------------------------------------------------------------
// Admin UI
// ---------------------------------------------------------------------------

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AMS CMS — Aligned</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--panel2:#1e222c;--line:#2a2f3a;--text:#e8eaef;--muted:#9aa3b2;--accent:#f97316;--accent2:#38bdf8;--green:#22c55e;--red:#ef4444}
  *{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
  a{color:var(--accent2)}button{cursor:pointer;border:0;border-radius:8px;padding:9px 14px;font-weight:600;font-size:14px}
  .btn{background:var(--accent);color:#fff}.btn:hover{filter:brightness(1.1)}
  .btn-ghost{background:var(--panel2);color:var(--text);border:1px solid var(--line)}
  .btn-danger{background:transparent;color:var(--red);border:1px solid var(--red)}
  input,select,textarea{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:10px 12px;font-size:14px}
  textarea{min-height:140px;resize:vertical}label{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);display:block;margin:14px 0 6px}
  .layout{display:grid;grid-template-columns:260px 1fr;min-height:100vh}
  .sidebar{background:var(--panel);border-right:1px solid var(--line);padding:22px}
  .logo{font-size:22px;font-weight:800}.logo span{color:var(--accent)}
  .sub{color:var(--muted);font-size:13px;margin:4px 0 24px}
  .nav button{display:block;width:100%;text-align:left;background:transparent;color:var(--muted);margin-bottom:6px}
  .nav button.active{background:var(--panel2);color:var(--text);border:1px solid var(--line)}
  .badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:var(--panel2);border:1px solid var(--line);color:var(--muted)}
  .badge.pub{color:var(--green);border-color:var(--green)}
  .main{padding:28px;max-width:1100px}
  h1{font-size:26px;margin:0 0 4px}.muted{color:var(--muted);font-size:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-top:18px}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .row.space{justify-content:space-between}
  .item{display:flex;justify-content:space-between;gap:12px;padding:14px;border:1px solid var(--line);border-radius:12px;margin-top:10px;background:var(--panel2)}
  .item h3{margin:0 0 4px;font-size:16px}.item p{margin:0;color:var(--muted);font-size:13px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .toast{position:fixed;bottom:20px;right:20px;background:var(--panel2);border:1px solid var(--line);padding:12px 16px;border-radius:10px;display:none;z-index:99}
  @media(max-width:800px){.layout{grid-template-columns:1fr}.sidebar{border-right:0;border-bottom:1px solid var(--line)}.grid2{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="logo">AMS <span>CMS</span></div>
    <div class="sub">Aligned · Cloudflare Worker<br>D1: <b>bcms</b> · KV: <b>bcms</b></div>
    <nav class="nav">
      <button class="active" data-view="dashboard">Dashboard</button>
      <button data-view="content">Content</button>
      <button data-view="settings">Settings (KV)</button>
      <button data-view="api">API</button>
    </nav>
    <div class="card" style="margin-top:24px">
      <label>Admin token</label>
      <input id="token" type="password" placeholder="Bearer token (if set)">
      <p class="muted" style="font-size:12px">Saved in your browser only. Needed for create / edit / delete when ADMIN_TOKEN is set.</p>
    </div>
    <p class="muted" style="font-size:12px;margin-top:16px"><a href="/api/health" target="_blank">/api/health</a> · <a href="/api/content" target="_blank">/api/content</a></p>
  </aside>

  <main class="main">
    <section id="view-dashboard">
      <h1>Dashboard</h1><p class="muted">Your aligned CMS on Cloudflare Workers.</p>
      <div class="card"><div class="row space"><div><b id="statTotal">—</b> <span class="muted">total items</span></div><div><b id="statPub">—</b> <span class="muted">published</span></div><div id="statHealth" class="badge">checking…</div></div></div>
      <div class="card"><h3 style="margin-top:0">Quick start</h3><p class="muted">Create content, publish it, and read it back from <code>/api/content</code>. List responses are cached in KV (<b>bcms</b>) for 60 seconds and invalidated on every write.</p><button class="btn" onclick="showView('content')">New content</button></div>
    </section>

    <section id="view-content" style="display:none">
      <div class="row space"><div><h1>Content</h1><p class="muted">Stored in D1 database <b>bcms</b></p></div><button class="btn" onclick="openEditor()">+ New</button></div>
      <div class="card">
        <div class="row">
          <select id="filterStatus" style="max-width:160px"><option value="">All statuses</option><option value="published">Published</option><option value="draft">Draft</option></select>
          <select id="filterType" style="max-width:160px"><option value="">All types</option><option value="page">Page</option><option value="post">Post</option></select>
          <button class="btn-ghost" onclick="loadContent()">Refresh</button>
          <button class="btn-ghost" onclick="clearCache()">Clear KV cache</button>
        </div>
        <div id="list"></div>
      </div>
      <div class="card" id="editor" style="display:none">
        <h3 id="editorTitle" style="margin-top:0">New content</h3>
        <input type="hidden" id="fId">
        <label>Title *</label><input id="fTitle" placeholder="Page title">
        <div class="grid2">
          <div><label>Slug</label><input id="fSlug" placeholder="auto from title"></div>
          <div><label>Type</label><select id="fType"><option value="page">Page</option><option value="post">Post</option></select></div>
        </div>
        <div class="grid2">
          <div><label>Status</label><select id="fStatus"><option value="draft">Draft</option><option value="published">Published</option></select></div>
          <div><label>Cover image URL</label><input id="fCover" placeholder="https://…"></div>
        </div>
        <label>Excerpt</label><input id="fExcerpt" placeholder="Short summary">
        <label>Body (Markdown)</label><textarea id="fBody" placeholder="# Hello"></textarea>
        <div class="row" style="margin-top:16px"><button class="btn" onclick="saveContent()">Save</button><button class="btn-ghost" onclick="closeEditor()">Cancel</button></div>
      </div>
    </section>

    <section id="view-settings" style="display:none">
      <h1>Settings</h1><p class="muted">Stored in KV namespace <b>bcms</b> (mirrored to D1).</p>
      <div class="card">
        <label>Site name</label><input id="sName" placeholder="AMS CMS">
        <label>Site tagline</label><input id="sTagline" placeholder="Aligned content management">
        <div class="row" style="margin-top:16px"><button class="btn" onclick="saveSettings()">Save settings</button><button class="btn-ghost" onclick="loadSettings()">Reload</button></div>
      </div>
    </section>

    <section id="view-api" style="display:none">
      <h1>API</h1><p class="muted">Base URL is this Worker. Writes need <code>Authorization: Bearer &lt;ADMIN_TOKEN&gt;</code> when a token is set.</p>
      <div class="card"><pre style="white-space:pre-wrap;font-size:13px">GET    /api/health
GET    /api/stats
GET    /api/content?status=published&type=post
POST   /api/content          { title, slug?, type, status, excerpt, body, cover_image, meta }
GET    /api/content/:id
PUT    /api/content/:id
DELETE /api/content/:id
GET    /api/settings
PUT    /api/settings          { site_name, site_tagline, ... }
POST   /api/cache/clear</pre></div>
    </section>
  </main>
</div>
<div class="toast" id="toast"></div>

<script>
const $ = id => document.getElementById(id);
const tokenInput = $('token');
tokenInput.value = localStorage.getItem('ams_token') || '';
tokenInput.addEventListener('change', () => localStorage.setItem('ams_token', tokenInput.value.trim()));

function headers(){ const t = tokenInput.value.trim(); return { 'Content-Type':'application/json', ...(t?{Authorization:'Bearer '+t}:{}) }; }
function toast(msg){ const el=$('toast'); el.textContent=msg; el.style.display='block'; setTimeout(()=>el.style.display='none',2600); }

function showView(name){
  document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active', b.dataset.view===name));
  ['dashboard','content','settings','api'].forEach(v=> $('view-'+v).style.display = v===name ? 'block':'none');
  if(name==='content') loadContent();
  if(name==='settings') loadSettings();
  if(name==='dashboard') loadStats();
}
document.querySelectorAll('.nav button').forEach(b=> b.addEventListener('click', ()=>showView(b.dataset.view)));

async function loadStats(){
  try{
    const s = await (await fetch('/api/stats')).json();
    $('statTotal').textContent = s.total ?? 0; $('statPub').textContent = s.published ?? 0;
    const h = await (await fetch('/api/health')).json();
    const el = $('statHealth'); el.textContent = h.ok ? 'D1 + KV connected' : 'DB not ready — run migrations'; el.className = 'badge' + (h.ok?' pub':'');
  }catch(e){ $('statHealth').textContent = 'API unreachable'; }
}

async function loadContent(){
  const status=$('filterStatus').value, type=$('filterType').value;
  const q = new URLSearchParams({...(status?{status}:{}), ...(type?{type}:{})}).toString();
  const res = await fetch('/api/content'+(q?'?'+q:''));
  const {data} = await res.json();
  $('list').innerHTML = !data?.length
    ? '<p class="muted">No content yet. Click “+ New” to create your first page.</p>'
    : data.map(item => \`
      <div class="item">
        <div><h3>\${escapeHtml(item.title)}</h3><p>/\${escapeHtml(item.slug)} · \${escapeHtml(item.type)} · \${escapeHtml(item.updated_at||'')}</p></div>
        <div class="row"><span class="badge \${item.status==='published'?'pub':''}">\${escapeHtml(item.status)}</span>
        <button class="btn-ghost" onclick="editItem(\${item.id})">Edit</button>
        <button class="btn-danger" onclick="deleteItem(\${item.id})">Delete</button></div>
      </div>\`).join('');
}
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function openEditor(){ $('editor').style.display='block'; $('editorTitle').textContent='New content'; ['fId','fTitle','fSlug','fExcerpt','fBody','fCover'].forEach(id=>$(id).value=''); $('fType').value='page'; $('fStatus').value='draft'; $('fTitle').focus(); }
function closeEditor(){ $('editor').style.display='none'; }

async function editItem(id){
  const {data} = await (await fetch('/api/content/'+id)).json();
  if(!data) return toast('Not found');
  openEditor(); $('editorTitle').textContent='Edit: '+data.title;
  $('fId').value=data.id; $('fTitle').value=data.title; $('fSlug').value=data.slug;
  $('fType').value=data.type; $('fStatus').value=data.status;
  $('fExcerpt').value=data.excerpt||''; $('fBody').value=data.body||''; $('fCover').value=data.cover_image||'';
}

async function saveContent(){
  const payload = { title:$('fTitle').value.trim(), slug:$('fSlug').value.trim(), type:$('fType').value, status:$('fStatus').value, excerpt:$('fExcerpt').value, body:$('fBody').value, cover_image:$('fCover').value };
  if(!payload.title) return toast('Title is required');
  const id = $('fId').value;
  const res = await fetch(id ? '/api/content/'+id : '/api/content', { method: id?'PUT':'POST', headers:headers(), body:JSON.stringify(payload) });
  const out = await res.json();
  if(!res.ok) return toast(out.error || 'Save failed');
  toast('Saved'); closeEditor(); loadContent(); loadStats();
}

async function deleteItem(id){
  if(!confirm('Delete this item?')) return;
  const res = await fetch('/api/content/'+id, { method:'DELETE', headers:headers() });
  if(!res.ok) return toast((await res.json()).error || 'Delete failed');
  toast('Deleted'); loadContent(); loadStats();
}

async function clearCache(){
  const res = await fetch('/api/cache/clear', { method:'POST', headers:headers() });
  toast(res.ok ? 'KV cache cleared' : 'Clear failed (check token)');
}

async function loadSettings(){
  const {data} = await (await fetch('/api/settings')).json();
  $('sName').value = data?.site_name || ''; $('sTagline').value = data?.site_tagline || '';
}
async function saveSettings(){
  const res = await fetch('/api/settings', { method:'PUT', headers:headers(), body:JSON.stringify({ site_name:$('sName').value, site_tagline:$('sTagline').value }) });
  toast(res.ok ? 'Settings saved to KV (bcms)' : 'Save failed (check token)');
}

$('filterStatus').addEventListener('change', loadContent);
$('filterType').addEventListener('change', loadContent);
loadStats();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (path === "/" && request.method === "GET") {
        return new Response(UI_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (path === "/api/health" && request.method === "GET") return handleHealth(env);
      if (path === "/api/stats" && request.method === "GET") return handleStats(env);
      if (path === "/api/content" && request.method === "GET") return listContent(env, url);
      if (path === "/api/content" && request.method === "POST") return createContent(request, env);
      if (path === "/api/settings" && request.method === "GET") return getSettings(env);
      if (path === "/api/settings" && request.method === "PUT") return saveSettings(request, env);
      if (path === "/api/cache/clear" && request.method === "POST") {
        const denied = requireAuth(request, env);
        if (denied) return denied;
        await kvDelete(env, CACHE_KEY);
        return json({ ok: true });
      }

      const match = path.match(/^\/api\/content\/(\d+)$/);
      if (match) {
        const id = match[1];
        if (request.method === "GET") return getContent(env, id);
        if (request.method === "PUT") return updateContent(request, env, id);
        if (request.method === "DELETE") return deleteContent(request, env, id);
      }

      return json({ error: "Not found", path }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: "Internal server error", detail: String(err?.message || err) }, 500);
    }
  },
};
