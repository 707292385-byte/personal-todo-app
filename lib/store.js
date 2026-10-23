'use strict';
/**
 * 多用户存储：注册/登录（scrypt 加盐）、按用户隔离的 JSON 文件、原子写入、旧单用户数据迁移。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tasks = require('./tasks');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USERS_DIR = path.join(DATA_DIR, 'users');
const LEGACY_FILE = path.join(DATA_DIR, 'records.json');

function ensureDirs() {
  fs.mkdirSync(USERS_DIR, { recursive: true });
}
ensureDirs();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

/* ---------- 服务端签名密钥（token 跨重启有效） ---------- */
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
let SECRET = '';
try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { SECRET = ''; }
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SECRET);
}

/* ---------- 用户 ---------- */
let users = readJson(USERS_FILE, { users: [] });

function saveUsers() { writeJson(USERS_FILE, users); }
function isOpenForRegistration() {
  return users.users.length === 0;
}
function findUser(username) {
  const name = String(username || '').trim().toLowerCase();
  return users.users.find((u) => u.username === name) || null;
}
function validName(name) {
  return typeof name === 'string' && /^[\w\u4e00-\u9fa5-]{2,20}$/.test(name.trim());
}
function createUser(username, password) {
  if (users.users.length > 0) {
    throw new Error('注册已关闭：本应用为单人独立部署，仅首位使用者可注册');
  }
  const name = String(username).trim().toLowerCase();
  if (!validName(name)) throw new Error('用户名须为 2-20 位字母、数字、中文或连字符');
  if (typeof password !== 'string' || password.length < 6) throw new Error('口令至少 6 位');
  if (findUser(name)) throw new Error('用户名已存在');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  const user = { username: name, salt, hash, created_at: new Date().toISOString(), legacy_imported: false };
  users.users.push(user);
  saveUsers();
  return user;
}
function verifyPassword(user, password) {
  const hash = crypto.scryptSync(String(password), user.salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.hash));
}
function tokenFor(username) {
  return crypto.createHmac('sha256', SECRET).update('user:' + username).digest('hex');
}
function userByToken(token) {
  const name = String(token || '');
  for (const u of users.users) {
    const t = tokenFor(u.username);
    if (t.length === name.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(name))) return u;
  }
  return null;
}

/* ---------- 每用户数据 ---------- */
function userFile(username) {
  return path.join(USERS_DIR, encodeURIComponent(username) + '.json');
}
function blankData() {
  return {
    tasks: [], categories: [], recurrences: [], slots: [], sessions: [], focus: null,
    layout: tasks.DEFAULT_LAYOUT.map((i) => ({ ...i })),
    revision: 0,
  };
}
function loadUserData(username) {
  const data = { ...blankData(), ...(readJson(userFile(username), null) || {}) };
  /* 旧版布局升级须立即落盘，否则 revision 只改在内存里，后续布局保存会一直 409 冲突 */
  if (tasks.migrateLayout(data)) saveUserData(username, data);
  return data;
}
function saveUserData(username, data) {
  writeJson(userFile(username), data);
}

/**
 * 旧版单用户数据迁移：首个注册用户自动继承 data/records.json 里的记录。
 */
function maybeImportLegacy(user) {
  if (user.legacy_imported) return false;
  user.legacy_imported = true;
  saveUsers();
  const legacy = readJson(LEGACY_FILE, null);
  if (!legacy || !Array.isArray(legacy.records)) return false;
  const data = loadUserData(user.username);
  const catByName = {};
  for (const r of legacy.records) {
    let catId = '';
    const tagName = String(r.tag || '').trim();
    if (tagName) {
      if (!catByName[tagName]) {
        catByName[tagName] = { id: crypto.randomUUID(), name: tagName, created_at: Date.now() };
        data.categories.push(catByName[tagName]);
      }
      catId = catByName[tagName].id;
    }
    const day = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : '';
    data.tasks.push({
      id: crypto.randomUUID(),
      title: String(r.text || '').trim(),
      start_date: '',
      due_date: day,
      start_time: '',
      end_time: '',
      time_period: '全天',
      status: r.done ? '已完成' : '待办',
      importance: '未判断',
      priority_level: '无',
      recurrence: 'none',
      category_id: catId,
      created_at: r.createdAt || Date.now(),
      updated_at: r.updatedAt || r.createdAt || Date.now(),
      completed_at: r.done ? (r.updatedAt || Date.now()) : null,
    });
  }
  saveUserData(user.username, data);
  try { fs.renameSync(LEGACY_FILE, LEGACY_FILE + '.imported-' + Date.now()); } catch (e) { /* 保留原文件 */ }
  return legacy.records.length;
}

module.exports = {
  findUser, createUser, verifyPassword, tokenFor, userByToken,
  loadUserData, saveUserData, maybeImportLegacy, blankData,
  isOpenForRegistration,
};
