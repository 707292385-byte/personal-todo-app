'use strict';
/**
 * 任务业务逻辑：字段校验、状态流转、重复待办生成、专注计时、投入时段、统计。
 * 规则对齐工作台 personal_task_rules / todo_workspace。
 */
const crypto = require('crypto');
const { shanghaiToday } = require('./timeparse');

const STATUSES = ['待办', '今日待办', '进行中', '已完成', '已归档'];
const TIME_PERIODS = ['全天', '上午', '下午', '晚上'];
const IMPORTANCE = ['未判断', '一般', '重要'];
const PRIORITIES = ['高', '中', '低', '无'];
const FREQUENCIES = ['none', 'daily', 'weekly', 'monthly'];
const FOCUS_STATUSES = ['待办', '今日待办', '进行中'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const WIDGETS = ['input', 'list', 'quad', 'cal', 'focus', 'timeline', 'board', 'stats'];
function validateLayout(body, data) {
  if (body.revision !== data.revision) throw new Error('布局已在其他页面更新，请刷新后再编辑');
  const layout = body.layout;
  if (!Array.isArray(layout) || layout.length > WIDGETS.length) throw new Error('组件布局无效');
  const seen = new Set();
  const clean = [];
  for (const item of layout) {
    if (!WIDGETS.includes(item.id) || seen.has(item.id)) throw new Error('组件布局无效');
    const w = item.w;
    if (!Number.isInteger(w) || w < 3 || w > 12) throw new Error('组件宽度无效');
    const h = item.h === undefined ? 2 : item.h;
    if (!Number.isInteger(h) || h < 1 || h > 4) throw new Error('组件高度无效');
    seen.add(item.id);
    clean.push({ id: item.id, w, h });
  }
  data.layout = clean;
  data.revision += 1;
  return data.revision;
}
/* 默认看板版式（对齐工作台「今日待办」页）：输入条通栏 / 看板 3/4 + 专注 1/4 / 时间线通栏 / 日历通栏。
   任务清单、四象限、统计不进默认布局，可从「添加组件」手动加。 */
const LAYOUT_VERSION = 2;
const DEFAULT_LAYOUT = [
  { id: 'input', w: 12, h: 1 },
  { id: 'board', w: 9, h: 3 }, { id: 'focus', w: 3, h: 3 },
  { id: 'timeline', w: 12, h: 2 },
  { id: 'cal', w: 12, h: 3 },
];
/* 布局版本升级：layoutVersion 低于当前版本时整体替换为最新默认版式（一次性，用户此后可自由调整） */
function migrateLayout(data) {
  if (data.layoutVersion === LAYOUT_VERSION && Array.isArray(data.layout)) return false;
  data.layout = DEFAULT_LAYOUT.map((i) => ({ ...i }));
  data.layoutVersion = LAYOUT_VERSION;
  data.revision = (data.revision || 0) + 1;
  return true;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() { return shanghaiToday(); }
function addDaysStr(ymd, n) {
  const dt = new Date(ymd + 'T12:00:00Z');
  return new Date(dt.getTime() + n * 86400000).toISOString().slice(0, 10);
}
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/* ---------- 字段校验（对齐工作台 fields()） ---------- */
function validateFields(patch, old, creating) {
  const out = {};
  const bad = (msg) => { throw new Error(msg); };
  for (const [key, choices] of [
    ['time_period', TIME_PERIODS], ['importance', IMPORTANCE], ['priority_level', PRIORITIES], ['recurrence', FREQUENCIES],
  ]) {
    if (patch[key] !== undefined) {
      if (!choices.includes(patch[key])) {
        bad({ time_period: '时段无效', importance: '重要性无效', priority_level: '紧急程度无效', recurrence: '重复方式须为不重复、每日、每周或每月' }[key]);
      }
      out[key] = patch[key];
    }
  }
  for (const key of ['start_date', 'due_date']) {
    if (patch[key] !== undefined) {
      if (patch[key] !== null && patch[key] !== '' && !DAY_RE.test(patch[key])) bad('日期格式无效');
      out[key] = patch[key] || '';
    }
  }
  for (const key of ['start_time', 'end_time']) {
    if (patch[key] !== undefined) {
      if (patch[key] !== null && patch[key] !== '' && !TIME_RE.test(patch[key])) bad('时间格式无效');
      out[key] = patch[key] || '';
    }
  }
  if (patch.title !== undefined) {
    const t = String(patch.title || '').trim();
    if (!t) bad('标题不能为空');
    if (t.length > 2000) bad('标题过长');
    out.title = t;
  } else if (creating) {
    bad('标题不能为空');
  }
  if (patch.category_id !== undefined) out.category_id = String(patch.category_id || '');
  if (creating) {
    out.status = STATUSES.includes(patch.status) ? patch.status : '待办';
    out.importance = out.importance || '未判断';
    out.priority_level = out.priority_level || '无';
    out.time_period = out.time_period || '全天';
    out.recurrence = out.recurrence || 'none';
    out.start_date = out.start_date || '';
    out.due_date = out.due_date || '';
    out.start_time = out.start_time || '';
    out.end_time = out.end_time || '';
  }
  const merged = { ...(old || {}), ...out };
  const { start_date: sd, due_date: dd, start_time: st, end_time: et } = merged;
  if ((st || et) && !(sd || dd)) bad('请先为时间设置对应日期');
  if (et && !dd) bad('请先为结束时间设置截止日期');
  if (sd && dd && sd > dd) bad('结束日期不能早于开始日期');
  if ((sd || dd) === dd && st && et && st >= et) bad('结束时间须晚于开始时间');
  if ((merged.recurrence || 'none') !== 'none' && !dd) bad('重复待办需要截止日期');
  return out;
}

/* ---------- 重复待办 ---------- */
function nextDate(current, frequency, anchor, monthDay) {
  if (frequency === 'daily') return addDaysStr(current, 1);
  if (frequency === 'weekly') return addDaysStr(current, 7);
  const c = current.split('-').map(Number);
  const y = c[0] + (c[1] === 12 ? 1 : 0);
  const m = c[1] % 12 + 1;
  const day = Math.min(monthDay || Number(anchor.split('-')[2]), lastDayOfMonth(y, m));
  return `${y}-${pad2(m)}-${pad2(day)}`;
}
function occursOn(rule, day) {
  if (!day || day < rule.anchor) return false;
  if (rule.frequency === 'daily') return true;
  if (rule.frequency === 'weekly') {
    return Math.floor(Date.parse(day + 'T12:00:00Z') / 86400000) % 7
      === Math.floor(Date.parse(rule.anchor + 'T12:00:00Z') / 86400000) % 7;
  }
  if (rule.frequency === 'monthly') {
    const [y, m, d0] = day.split('-').map(Number);
    return d0 === Math.min(rule.month_day || Number(rule.anchor.split('-')[2]), lastDayOfMonth(y, m));
  }
  return false;
}
/** 把到期规则滚动生成新任务（幂等：同 recurrence_id+due_date 已存在则跳过），返回是否有变更 */
function rollRecurrences(data) {
  const today = todayStr();
  let changed = false;
  for (const rule of data.recurrences) {
    if (!rule.active) continue;
    let guard = 0;
    while (rule.next_due && rule.next_due <= today && guard++ < 400) {
      const exists = data.tasks.some((t) => t.recurrence_id === rule.id && t.due_date === rule.next_due);
      if (!exists) {
        const tpl = rule.template || {};
        data.tasks.push({
          id: crypto.randomUUID(),
          title: tpl.title || rule.title,
          start_date: tpl.start_date ? rule.next_due : '',
          due_date: rule.next_due,
          start_time: tpl.start_time || '',
          end_time: tpl.end_time || '',
          time_period: tpl.time_period || '全天',
          status: '今日待办',
          importance: tpl.importance || '未判断',
          priority_level: tpl.priority_level || '无',
          recurrence: 'none',
          recurrence_id: rule.id,
          category_id: tpl.category_id || '',
          created_at: Date.now(),
          updated_at: Date.now(),
          completed_at: null,
        });
        changed = true;
      }
      rule.next_due = nextDate(rule.next_due, rule.frequency, rule.anchor, rule.month_day);
      changed = true;
    }
  }
  return changed;
}
/** 创建/更新带重复的任务时同步规则 */
function syncRecurrenceRule(data, task) {
  if (task.recurrence === 'none') {
    if (task.recurrence_id) {
      const rule = data.recurrences.find((r) => r.id === task.recurrence_id);
      if (rule) {
        // 该任务不再重复且没有其他实例时停用规则
        const others = data.tasks.some((t) => t.id !== task.id && t.recurrence_id === rule.id);
        if (!others) rule.active = false;
      }
      delete task.recurrence_id;
    }
    return;
  }
  let rule = task.recurrence_id && data.recurrences.find((r) => r.id === task.recurrence_id);
  if (!rule) rule = { id: crypto.randomUUID(), created_at: Date.now() }, data.recurrences.push(rule);
  Object.assign(rule, {
    active: true,
    title: task.title,
    frequency: task.recurrence,
    anchor: task.due_date,
    month_day: task.recurrence === 'monthly' ? Number(task.due_date.split('-')[2]) : null,
    next_due: nextDate(task.due_date, task.recurrence, task.due_date, task.recurrence === 'monthly' ? Number(task.due_date.split('-')[2]) : null),
    template: {
      title: task.title, start_date: task.start_date ? task.due_date : '',
      start_time: task.start_time, end_time: task.end_time, time_period: task.time_period,
      importance: task.importance, priority_level: task.priority_level, category_id: task.category_id,
    },
  });
  task.recurrence_id = rule.id;
}

/* ---------- 状态流转 ---------- */
const TRANSITIONS = {
  '待办': ['今日待办', '进行中', '已完成', '已归档'],
  '今日待办': ['待办', '进行中', '已完成', '已归档'],
  '进行中': ['待办', '今日待办', '已完成', '已归档'],
  '已完成': ['待办', '今日待办', '进行中', '已归档'],
  '已归档': [],
};
function transition(data, task, next) {
  if (!STATUSES.includes(next)) throw new Error('状态无效');
  if (next === task.status) return;
  if (!TRANSITIONS[task.status].includes(next)) throw new Error(`不能从「${task.status}」变更为「${next}」`);
  const prev = task.status;
  task.status = next;
  if (next === '已完成') task.completed_at = Date.now();
  if (prev === '已完成') task.completed_at = null;
  if (next === '已归档' && task.recurrence_id) {
    const rule = data.recurrences.find((r) => r.id === task.recurrence_id);
    const others = data.tasks.some((t) => t.id !== task.id && t.recurrence_id === rule.id && t.status !== '已归档');
    if (rule && !others) rule.active = false;
  }
  task.updated_at = Date.now();
}

/* ---------- 专注计时 ---------- */
function nowSec() { return Math.floor(Date.now() / 1000); }
function segmentElapsed(focus, sec) {
  let total = 0;
  for (const s of focus.segments) total += s.ended_at - s.started_at;
  if (focus.running) total += sec - focus.started_at;
  return total;
}
function startFocus(data, body) {
  if (data.focus) throw new Error('已有专注计时，请先结束或继续当前专注');
  const task = data.tasks.find((t) => t.id === body.task_id);
  if (!task) throw new Error('任务不存在');
  if (!FOCUS_STATUSES.includes(task.status)) throw new Error('此任务当前不能开始专注');
  const minutes = body.minutes || 25;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) throw new Error('专注时长须为5至120分钟');
  const prev = task.status;
  task.status = '进行中';
  task.updated_at = Date.now();
  const sec = nowSec();
  data.focus = {
    id: crypto.randomUUID(), task_id: task.id, running: true,
    started_at: sec, ends_at: sec + minutes * 60, remaining: minutes * 60,
    total: minutes * 60, elapsed: 0, segments: [], date: todayStr(), prev_status: prev,
  };
  return data.focus;
}
function findFocus(data, body) {
  if (!data.focus || body.focus_id !== data.focus.id) {
    if (!data.focus && data.sessions.some((s) => s.id === body.focus_id)) return { finished: true };
    throw new Error('专注状态已变化，请刷新后重试');
  }
  return data.focus;
}
function focusOp(data, body) {
  const op = body.operation;
  const sec = nowSec();
  if (op === 'start') return { focus: startFocus(data, body) };
  const focus = findFocus(data, body);
  if (focus.finished) return { already_finished: true };
  const task = data.tasks.find((t) => t.id === focus.task_id);
  if (op === 'pause') {
    if (focus.running) {
      focus.segments.push({ started_at: focus.started_at, ended_at: sec });
      focus.elapsed = segmentElapsed({ ...focus, running: false }, sec);
      focus.remaining = Math.max(0, focus.ends_at - sec);
      focus.running = false;
    }
  } else if (op === 'resume') {
    if (!focus.running) {
      if (task && task.status !== '进行中') throw new Error('任务状态已改变，请结束本次专注后重新开始');
      focus.started_at = sec;
      focus.ends_at = sec + focus.remaining;
      focus.running = true;
    }
  } else if (op === 'adjust') {
    if (focus.running) throw new Error('请先暂停，再调整专注时长');
    const minutes = body.minutes;
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) throw new Error('专注时长须为5至120分钟');
    if (minutes * 60 <= focus.elapsed) throw new Error('总时长须大于已经专注的时间');
    focus.total = minutes * 60;
    focus.remaining = minutes * 60 - focus.elapsed;
  } else if (op === 'finish') {
    if (focus.running) {
      focus.segments.push({ started_at: focus.started_at, ended_at: Math.min(sec, focus.ends_at) });
      focus.elapsed = segmentElapsed({ ...focus, running: false }, sec);
      focus.running = false;
    }
    data.sessions.push({
      id: focus.id, task_id: focus.task_id, date: focus.date,
      total: focus.total, elapsed: focus.elapsed, segments: focus.segments, finished_at: sec,
    });
    data.focus = null;
  } else if (op === 'sync') {
    if (focus.running && sec >= focus.ends_at) {
      focus.segments.push({ started_at: focus.started_at, ended_at: focus.ends_at });
      focus.elapsed = focus.total;
      focus.running = false;
      data.sessions.push({
        id: focus.id, task_id: focus.task_id, date: focus.date,
        total: focus.total, elapsed: focus.elapsed, segments: focus.segments, finished_at: focus.ends_at,
      });
      data.focus = null;
    }
  } else {
    throw new Error('专注操作无效');
  }
  return { focus: data.focus };
}
/** 拉取状态时把超时专注自动收尾（对齐工作台 reconcile） */
function reconcileFocus(data) {
  if (data.focus && data.focus.running && nowSec() >= data.focus.ends_at) {
    focusOp(data, { operation: 'sync', focus_id: data.focus.id });
  }
}

/* ---------- 投入时段 ---------- */
function validateSlot(body) {
  const day = body.date || '';
  if (!DAY_RE.test(day)) throw new Error('日期格式无效');
  const start = body.start, end = body.end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > 1440) {
    throw new Error('投入时段须在当天范围内，结束晚于开始');
  }
}

/* ---------- 快照与统计 ---------- */
function snapshot(data) {
  reconcileFocus(data);
  const changed = rollRecurrences(data);
  const today = todayStr();
  const tasks = [...data.tasks]
    .filter((t) => t.status !== '已归档')
    .sort((a, b) => (b.due_date || '').localeCompare(a.due_date || '') || b.created_at - a.created_at)
    .map((t) => ({ ...t }));
  return { tasks, data, today, changed };
}
function investedMinutesOn(data, day) {
  let total = 0;
  for (const s of data.sessions) {
    for (const seg of s.segments) {
      const startDay = new Date(seg.started_at * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      const endDay = new Date(seg.ended_at * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
      if (startDay <= day && day <= endDay) {
        total += Math.round((Math.min(seg.ended_at, ...endBoundary(day)) - Math.max(seg.started_at, startBoundary(day))) / 60);
      }
    }
  }
  for (const s of data.slots) if (s.date === day) total += s.end - s.start;
  return Math.max(0, total);
}
function startBoundary(day) { return Math.floor(Date.parse(day + 'T00:00:00+08:00') / 1000); }
function endBoundary(day) { return [Math.floor(Date.parse(day + 'T23:59:59+08:00') / 1000)]; }
function stats(data) {
  const today = todayStr();
  const weekStart = addDaysStr(today, -((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const perDay = {};
  for (let i = 0; i < 7; i++) {
    const day = addDaysStr(weekStart, i);
    perDay[day] = investedMinutesOn(data, day);
  }
  const byStatus = {};
  for (const s of STATUSES) byStatus[s] = 0;
  for (const t of data.tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const byCategory = {};
  for (const c of data.categories) byCategory[c.name] = { count: 0, done: 0 };
  for (const t of data.tasks) {
    const c = data.categories.find((x) => x.id === t.category_id);
    if (!c) continue;
    byCategory[c.name].count += 1;
    if (t.status === '已完成') byCategory[c.name].done += 1;
  }
  return { today_minutes: investedMinutesOn(data, today), week: perDay, by_status: byStatus, by_category: byCategory };
}

module.exports = {
  STATUSES, TIME_PERIODS, IMPORTANCE, PRIORITIES, FREQUENCIES, FOCUS_STATUSES, WIDGETS, LAYOUT_VERSION, DEFAULT_LAYOUT,
  validateLayout, migrateLayout, validateFields, transition, rollRecurrences, syncRecurrenceRule, occursOn,
  focusOp, reconcileFocus, validateSlot, snapshot, stats, todayStr,
};
