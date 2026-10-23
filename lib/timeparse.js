'use strict';
/**
 * 中文快捷录入时间解析 — 移植自工作台 personal_task_time.py，规则保持一致。
 * 返回 {start_date?, due_date?, start_time?, end_time?, time_period?, title?}，解析失败抛出中文错误。
 */

const DIGITS = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const PERIOD = '凌晨|早上|上午|中午|下午|傍晚|晚上|今晚|明晚';
const NUM = '[0-9零〇一二两三四五六七八九十]+';

const DATE_RE = /(?:20\d{2}[-年/]\d{1,2}[-月/]\d{1,2}[日号]?|\d{1,2}月\d{1,2}[日号]?|大后天|后天|明天|今天|今日|今晚|明晚|昨天|\d+天后|(?:下下|下|本|这)?(?:周|星期)[一二三四五六日天])/;
const DATE_RE_G = new RegExp(DATE_RE.source, 'g');
const SHORT_RANGE_RE = new RegExp('(?<![0-9零〇一二两三四五六七八九十:：])(?<first>(?:' + PERIOD + ')?\\s*' + NUM + ')\\s*(?<separator>到|至|[-—–~～－])\\s*(?=(?:' + PERIOD + ')?\\s*' + NUM + '(?:点|时|[:：]))', 'g');
const CLOCK_RE = new RegExp('(?<period>' + PERIOD + ')?\\s*(?<hour>' + NUM + ')(?:(?:点|时)(?:(?<half>半|一刻|三刻)|(?<minute>' + NUM + ')分?)?|[:：](?<colon>\\d{2}))', 'g');
const PERIOD_RE_G = new RegExp(PERIOD, 'g');

/* ---------- 日期基础（按上海时区计算"今天"，全部用 UTC 正午避免跨日问题） ---------- */
function shanghaiToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
}
function d(ymd) { return new Date(ymd + 'T12:00:00Z'); }
function iso(dt) { return dt.toISOString().slice(0, 10); }
function addDays(dt, n) { return new Date(dt.getTime() + n * 86400000); }

function number(text) {
  if (/^\d+$/.test(text)) return parseInt(text, 10);
  if (text.includes('十')) {
    const parts = text.split('十');
    const a = parts[0] ? DIGITS[parts[0]] : 1;
    const b = parts[1] ? DIGITS[parts[1]] : 0;
    return a * 10 + b;
  }
  let s = '';
  for (const c of text) s += DIGITS[c];
  return parseInt(s, 10);
}

function dayValue(token, today) {
  const offsets = { '今天': 0, '今日': 0, '今晚': 0, '明天': 1, '明晚': 1, '后天': 2, '大后天': 3, '昨天': -1 };
  if (token in offsets) return addDays(today, offsets[token]);
  const after = token.match(/^(\d+)天后$/);
  if (after) return addDays(today, parseInt(after[1], 10));
  const week = token.match(/^(下下|下|本|这)?(?:周|星期)([一二三四五六日天])$/);
  if (week) {
    const weekday = '一二三四五六日'.indexOf(week[2].replace('天', '日'));
    let delta = weekday - ((today.getUTCDay() + 6) % 7); // python weekday(): 周一=0
    if (week[1] === '下') delta += 7;
    else if (week[1] === '下下') delta += 14;
    else if (!week[1] && delta < 0) delta += 7;
    return addDays(today, delta);
  }
  const pieces = (token.match(/\d+/g) || []).map(Number);
  const ymd = pieces.length === 3 ? pieces : [today.getUTCFullYear(), ...pieces];
  const dt = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2], 12));
  if (dt.getUTCFullYear() !== ymd[0] || dt.getUTCMonth() !== ymd[1] - 1 || dt.getUTCDate() !== ymd[2]) {
    throw new Error('日期无效，请检查输入');
  }
  return dt;
}

function isDeadline(text, match) {
  const before = text.slice(0, match.index).replace(/\s+$/, '');
  const after = text.slice(match.index + match[0].length).replace(/^\s+/, '');
  const prefix = before.replace(new RegExp(DATE_RE.source), '').trim();
  if (/(?:截止|截至|最晚|不晚于)\s*$/.test(prefix)) return true;
  if (/^(?:之?前|以前|为止)/.test(after)) return true;
  if (/^(?:开始|起)/.test(after)) return false;
  return /^(?:完成|提交|交付|结束|写完|做完|定稿|收尾|到期|交(?:报告|稿|材料|资料|方案|作业|周报))/.test(after);
}

function parse(text, now, includeTitle) {
  const today = d(now || shanghaiToday());
  text = text.replace(SHORT_RANGE_RE, (m0, first, separator) => first + '点' + separator);
  const dates = [...text.matchAll(new RegExp(DATE_RE.source, 'g'))];
  const clocks = [];
  for (const m of text.matchAll(CLOCK_RE)) {
    if (['建议', '要求', '意见', '内容', '小时'].some((w) => text.slice(m.index + m[0].length).startsWith(w))) continue;
    if (m.index && text[m.index - 1] === '小') continue;
    clocks.push(m);
  }
  if (dates.length > 2 || clocks.length > 2) {
    throw new Error('有多组时间，请用表单指定这条待办的起止时间');
  }
  const out = {};
  if (dates.length) {
    const days = dates.map((m) => iso(dayValue(m[0], today)));
    if (days.length === 2 && days[0] !== days[1]) {
      if (!/到|至|[—~～]/.test(text.slice(dates[0].index + dates[0][0].length, dates[1].index))) {
        throw new Error('有两个不同日期，请用表单确定起止时间');
      }
      out.start_date = days[0];
      out.due_date = days[1];
    } else {
      out.due_date = days[days.length - 1];
    }
  }
  const periods = text.match(PERIOD_RE_G) || [];
  let lastPeriod = '';
  const times = [];
  for (const m of clocks) {
    let period = m.groups.period || lastPeriod;
    if (!period && dates.length && ['今晚', '明晚'].includes(dates[0][0])) period = dates[0][0];
    let hour = number(m.groups.hour);
    let minute = { '半': 30, '一刻': 15, '三刻': 45 }[m.groups.half] || 0;
    if (m.groups.minute || m.groups.colon) minute = number(m.groups.minute || m.groups.colon);
    if (['下午', '傍晚', '晚上', '今晚', '明晚'].includes(period) && hour >= 1 && hour < 12) hour += 12;
    else if (period === '中午' && hour >= 1 && hour < 11) hour += 12;
    else if (period === '凌晨' && hour === 12) hour = 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error('时间无效，请用表单设置正确时刻');
    }
    times.push(String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'));
    lastPeriod = period;
  }
  const setDefault = (k, v) => { if (out[k] === undefined) out[k] = v; };
  if (times.length === 2) {
    if (!/到|至|[—–~～－-]/.test(text.slice(clocks[0].index + clocks[0][0].length, clocks[1].index))) {
      throw new Error('有两个时刻，请用表单确定起止时间');
    }
    setDefault('due_date', iso(today));
    setDefault('start_date', out.due_date);
    out.start_time = times[0];
    out.end_time = times[1];
  } else if (times.length) {
    setDefault('due_date', iso(today));
    if (isDeadline(text, clocks[0])) {
      out.end_time = times[0];
    } else {
      if (!('start_date' in out)) out.start_date = out.due_date, delete out.due_date;
      out.start_time = times[0];
    }
  } else if (periods.length) {
    setDefault('due_date', iso(today));
  }
  if (periods.length) {
    const last = periods[periods.length - 1];
    out.time_period = ['傍晚', '晚上', '今晚', '明晚'].includes(last) ? '晚上'
      : ['中午', '下午'].includes(last) ? '下午' : '上午';
  }
  if (includeTitle) {
    const spans = dates.concat(clocks).map((m) => [m.index, m.index + m[0].length]);
    for (const m of text.matchAll(PERIOD_RE_G)) spans.push([m.index, m.index + m[0].length]);
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [a, b] of spans) {
      if (merged.length && (a <= merged[merged.length - 1][1] || /^[\s到至—–~～－-]*$/.test(text.slice(merged[merged.length - 1][1], a)))) {
        merged[merged.length - 1][1] = Math.max(b, merged[merged.length - 1][1]);
      } else merged.push([a, b]);
    }
    for (let i = merged.length - 1; i >= 0; i--) {
      let [a, b] = merged[i];
      const prefix = text.slice(0, a).match(/(?:截止|截至|最晚|不晚于)\s*$/);
      if (prefix) a = prefix.index;
      const suffix = text.slice(b).match(/^\s*(?:之前|以前|前|开始|起)(?=\D|$)/);
      if (suffix) b += suffix[0].length;
      text = text.slice(0, a) + ' ' + text.slice(b);
    }
    text = text.replace(/\s+/g, ' ').replace(/^[\s，,。；;：:]+|[\s，,。；;：:]+$/g, '');
    out.title = text.trim();
  }
  return out;
}

module.exports = { parse, shanghaiToday };
