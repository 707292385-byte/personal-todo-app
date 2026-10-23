'use strict';
/**
 * 工作记录待办（完整版）— 零依赖 Node HTTP 服务
 * 多用户：注册/登录，按用户隔离数据；单端口 HTTP，存储为 JSON 文件。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const tasks = require('./lib/tasks');
const timeparse = require('./lib/timeparse');

const PORT = process.env.PORT || 8788;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ---------- 工具 ---------- */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 512 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON 格式无效')); }
    });
    req.on('error', reject);
  });
}
function authUser(req) {
  return store.userByToken(req.headers['x-token']);
}

/* ---------- API ---------- */
async function handleApi(req, res, url) {
  const p = url.pathname;

  /* 站点元信息：注册通道是否开放（首位使用者注册后关闭） */
  if (p === '/api/meta' && req.method === 'GET') {
    return json(res, 200, { ok: true, registration_open: store.isOpenForRegistration(), version: 2 });
  }

  /* 登录 / 注册 */
  if (p === '/api/register' && req.method === 'POST') {
    const body = await readBody(req);
    let user;
    try { user = store.createUser(body.username, body.password); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const imported = store.maybeImportLegacy(user);
    return json(res, 200, { ok: true, token: store.tokenFor(user.username), username: user.username, imported });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const user = store.findUser(body.username);
    if (!user || !store.verifyPassword(user, body.password || '')) {
      return json(res, 401, { ok: false, error: '用户名或口令不正确' });
    }
    return json(res, 200, { ok: true, token: store.tokenFor(user.username), username: user.username });
  }

  const user = authUser(req);
  if (!user) return json(res, 401, { ok: false, error: '未登录或登录已失效' });
  const data = store.loadUserData(user.username);
  const persist = () => store.saveUserData(user.username, data);

  /* 快照 */
  if (p === '/api/state' && req.method === 'GET') {
    const snap = tasks.snapshot(data);
    if (snap.changed) persist();
    return json(res, 200, {
      ok: true,
      tasks: snap.tasks,
      categories: data.categories,
      recurrences: data.recurrences.filter((r) => r.active),
      slots: data.slots,
      sessions: data.sessions.slice(-50),
      focus: data.focus,
      layout: data.layout || [],
      revision: data.revision || 0,
      widgets: tasks.WIDGETS,
      stats: tasks.stats(data),
      today: snap.today,
    });
  }

  /* 桌面组件布局（对齐工作台 layout+revision 并发控制） */
  if (p === '/api/layout' && req.method === 'POST') {
    const body = await readBody(req);
    let revision;
    try { revision = tasks.validateLayout(body, data); }
    catch (e) { return json(res, 409, { ok: false, error: e.message, revision: data.revision }); }
    persist();
    return json(res, 200, { ok: true, revision, layout: data.layout });
  }

  /* 时间解析预览 */
  if (p === '/api/parse' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      return json(res, 200, { ok: true, fields: timeparse.parse(String(body.text || ''), null, true) });
    } catch (e) {
      return json(res, 200, { ok: true, fields: null, error: e.message });
    }
  }

  /* 新增任务 */
  if (p === '/api/tasks' && req.method === 'POST') {
    const body = await readBody(req);
    let payload = { ...(body.task || {}) };
    if (body.parse) {
      try {
        const parsed = timeparse.parse(payload.title || '', null, true);
        const cleanTitle = parsed.title;
        delete parsed.title;
        const manual = body.manual_dates || ['start_date', 'due_date', 'start_time', 'end_time'].some((k) => payload[k]);
        if (!manual) payload = { ...payload, ...parsed };
        payload.title = cleanTitle;
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }
    if (payload.category_id) {
      if (!data.categories.some((c) => c.id === payload.category_id)) return json(res, 400, { ok: false, error: '分类不存在' });
    }
    let values;
    try { values = tasks.validateFields(payload, null, true); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const task = {
      id: crypto.randomUUID(), created_at: Date.now(), updated_at: Date.now(),
      completed_at: null, recurrence_id: null,
      title: '', start_date: '', due_date: '', start_time: '', end_time: '',
      time_period: '全天', status: '待办', importance: '未判断', priority_level: '无',
      recurrence: 'none', category_id: '', ...values,
    };
    tasks.syncRecurrenceRule(data, task);
    data.tasks.push(task);
    persist();
    return json(res, 200, { ok: true, task });
  }

  /* 修改 / 删除任务 */
  const m = p.match(/^\/api\/tasks\/([\w-]+)$/);
  if (m && req.method === 'PUT') {
    const task = data.tasks.find((t) => t.id === m[1]);
    if (!task) return json(res, 404, { ok: false, error: '任务不存在' });
    const body = await readBody(req);
    const patch = body.patch || {};
    if (patch.category_id) {
      if (!data.categories.some((c) => c.id === patch.category_id)) return json(res, 400, { ok: false, error: '分类不存在' });
    }
    let values;
    try { values = tasks.validateFields(patch, task, false); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    Object.assign(task, values, { updated_at: Date.now() });
    if (values.recurrence !== undefined || values.due_date !== undefined) tasks.syncRecurrenceRule(data, task);
    persist();
    return json(res, 200, { ok: true, task });
  }
  if (m && req.method === 'POST') { /* 状态流转 */
    const task = data.tasks.find((t) => t.id === m[1]);
    if (!task) return json(res, 404, { ok: false, error: '任务不存在' });
    const body = await readBody(req);
    try { tasks.transition(data, task, body.status); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    persist();
    return json(res, 200, { ok: true, task });
  }
  if (m && req.method === 'DELETE') {
    const idx = data.tasks.findIndex((t) => t.id === m[1]);
    if (idx < 0) return json(res, 404, { ok: false, error: '任务不存在' });
    const [removed] = data.tasks.splice(idx, 1);
    if (removed.recurrence_id) {
      const rule = data.recurrences.find((r) => r.id === removed.recurrence_id);
      if (rule && !data.tasks.some((t) => t.recurrence_id === rule.id)) {
        data.recurrences = data.recurrences.filter((r) => r.id !== rule.id);
      }
    }
    data.slots = data.slots.filter((s) => s.task_id !== removed.id);
    persist();
    return json(res, 200, { ok: true });
  }

  /* 分类 */
  if (p === '/api/categories' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name || name.length > 30) return json(res, 400, { ok: false, error: '分类名须为 1-30 字' });
    if (data.categories.some((c) => c.name === name)) return json(res, 400, { ok: false, error: '分类已存在' });
    const cat = { id: crypto.randomUUID(), name, created_at: Date.now() };
    data.categories.push(cat);
    persist();
    return json(res, 200, { ok: true, category: cat });
  }
  const cm = p.match(/^\/api\/categories\/([\w-]+)$/);
  if (cm && req.method === 'PUT') {
    const cat = data.categories.find((c) => c.id === cm[1]);
    if (!cat) return json(res, 404, { ok: false, error: '分类不存在' });
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name || name.length > 30) return json(res, 400, { ok: false, error: '分类名须为 1-30 字' });
    cat.name = name;
    persist();
    return json(res, 200, { ok: true, category: cat });
  }
  if (cm && req.method === 'DELETE') {
    if (!data.categories.some((c) => c.id === cm[1])) return json(res, 404, { ok: false, error: '分类不存在' });
    data.categories = data.categories.filter((c) => c.id !== cm[1]);
    for (const t of data.tasks) if (t.category_id === cm[1]) t.category_id = '';
    persist();
    return json(res, 200, { ok: true });
  }

  /* 专注 */
  if (p === '/api/focus' && req.method === 'POST') {
    const body = await readBody(req);
    let result;
    try { result = tasks.focusOp(data, body); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    persist();
    return json(res, 200, { ok: true, ...result, focus: data.focus, sessions: data.sessions.slice(-50) });
  }

  /* 投入时段 */
  if (p === '/api/slots' && req.method === 'POST') {
    const body = await readBody(req);
    if (!data.tasks.some((t) => t.id === body.task_id)) return json(res, 404, { ok: false, error: '任务不存在' });
    try { tasks.validateSlot(body); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const slot = { id: crypto.randomUUID(), task_id: body.task_id, date: body.date, start: body.start, end: body.end };
    data.slots.push(slot);
    persist();
    return json(res, 200, { ok: true, slot });
  }
  const sm = p.match(/^\/api\/slots\/([\w-]+)$/);
  if (sm && req.method === 'PUT') {
    const slot = data.slots.find((s) => s.id === sm[1]);
    if (!slot) return json(res, 404, { ok: false, error: '投入时段不存在' });
    const body = await readBody(req);
    const merged = { ...slot, ...body };
    try { tasks.validateSlot(merged); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    Object.assign(slot, { date: merged.date, start: merged.start, end: merged.end });
    persist();
    return json(res, 200, { ok: true, slot });
  }
  if (sm && req.method === 'DELETE') {
    const before = data.slots.length;
    data.slots = data.slots.filter((s) => s.id !== sm[1]);
    if (data.slots.length === before) return json(res, 404, { ok: false, error: '投入时段不存在' });
    persist();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { ok: false, error: 'not found' });
}

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};
function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => json(res, 400, { ok: false, error: e.message || 'bad request' }));
    return;
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  serveStatic(res, path.join(PUBLIC_DIR, p));
});

server.listen(PORT, HOST, () => {
  console.log(`todo-mobile (full) listening on http://${HOST}:${PORT}`);
});
