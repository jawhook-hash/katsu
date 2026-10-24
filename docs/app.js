/* 活 — 30分の活動を記録する
 *
 * 30分後の知らせ:
 *   スタートで開始時刻を保存し、iPhone の「ショートカット」を呼ぶ（中身はリマインダーか時計のタイマー）。
 *   アプリ自身は音を出さない（活動中に音声を流す使い方があるため）。
 * 状態は開始時刻から計算する（タイマーの刻みには頼らない）。開き直して 30分過ぎていれば入力画面になる。
 * タイマーと関係なく、記録の追加・編集もできる。
 * ?test=10 で 10秒の試験モード（ショートカットは呼ばず、記録は本番と別の保存場所）。
 */
"use strict";

const VERSION = "2";
const TEST_SEC = Number(new URLSearchParams(location.search).get("test")) || 0;
const DUR = TEST_SEC > 0 ? TEST_SEC : 30 * 60; // 活動の長さ（秒）
const PREFIX = TEST_SEC > 0 ? "katsu-test" : "katsu";

const $ = id => document.getElementById(id);
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/* ---------- 色（分類は作った順に色の枠を割り当て、色は分類について回る） ---------- */
const SLOT_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const SLOT_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const darkMq = matchMedia("(prefers-color-scheme: dark)");
const slotColor = slot => (darkMq.matches ? SLOT_DARK : SLOT_LIGHT)[slot] || "#8a897f";

/* ---------- 小物 ---------- */
const pad2 = n => String(n).padStart(2, "0");
const hhmm = t => { const d = new Date(t); return `${d.getHours()}:${pad2(d.getMinutes())}`; };
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const keyToTime = key => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const dateLabel = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`; };
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const sumMin = list => list.reduce((s, r) => s + r.min, 0);

function fmtDur(min) {
  min = Math.round(min);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function dot(color) {
  const d = el("span", "dot");
  d.style.background = color;
  return d;
}

/* ---------- localStorage（読めない環境でも落ちないように） ---------- */
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(`${PREFIX}.${key}`); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function lsSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(`${PREFIX}.${key}`);
    else localStorage.setItem(`${PREFIX}.${key}`, JSON.stringify(value));
  } catch { /* 保存できなくても動作は続ける */ }
}

/* ---------- 分類 ---------- */
const DEFAULT_CATS = ["学習", "読書", "運動", "仕事", "その他"].map((name, i) => ({ id: `c${i + 1}`, name, slot: i }));
let cats = lsGet("cats", null) || DEFAULT_CATS;
const saveCats = () => lsSet("cats", cats);
const catById = id => cats.find(c => c.id === id);
const catName = id => (catById(id) || { name: "（分類なし）" }).name;
const catColor = id => slotColor((catById(id) || { slot: -1 }).slot);

function freeSlot() {
  const used = new Set(cats.map(c => c.slot));
  for (let i = 0; i < SLOT_LIGHT.length; i++) if (!used.has(i)) return i;
  return -1; // 9個目以降は灰色
}

/** 分類チップを並べる。選ぶと onPick(id) */
function renderChips(box, selectedId, onPick) {
  box.textContent = "";
  for (const c of cats) {
    const b = el("button", "chip" + (c.id === selectedId ? " on" : ""));
    b.type = "button";
    b.append(dot(slotColor(c.slot)), c.name);
    b.onclick = () => {
      box.querySelectorAll(".chip").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
      onPick(c.id);
    };
    box.append(b);
  }
}

/* ---------- 記録（IndexedDB） ---------- */
// 記録 = { id, start, end（ミリ秒）, min（分）, cat, text }
let db;
let records = []; // 開始時刻の昇順

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PREFIX, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("records", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDo(mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", mode);
    const req = fn(tx.objectStore("records"));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function loadRecords() {
  records = (await dbDo("readonly", s => s.getAll())) || [];
  records.sort((a, b) => a.start - b.start);
}
const putRecords = list => dbDo("readwrite", s => list.forEach(r => s.put(r)));
const deleteRecord = id => dbDo("readwrite", s => s.delete(id));

/** 開始時刻を id にする。同じ時刻の記録があれば 1ミリ秒ずらす */
function newId(start) {
  const used = new Set(records.map(r => r.id));
  let id = start;
  while (used.has(id)) id++;
  return id;
}

/* ---------- ショートカット ---------- */
let scName = lsGet("shortcut", "活タイマー");
const useShortcut = () => !TEST_SEC && scName !== "";

function runShortcut() {
  location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(scName)}`;
}

/* ---------- タイマー ---------- */
// session = { start: ミリ秒 } が保存されていれば活動中か入力待ち
let session = lsGet("session", null);
let pickedCat = lsGet("lastCat", cats[0] && cats[0].id);
const elapsedSec = () => (Date.now() - session.start) / 1000;
const endTime = () => session.start + DUR * 1000;

function showTimerPart(part) {
  for (const p of ["idle", "running", "done"]) $(`timer-${p}`).hidden = p !== part;
}

function startTimer() {
  session = { start: Date.now() };
  lsSet("session", session);
  renderTimer();
  if (useShortcut()) runShortcut();
}

function endSession() {
  session = null;
  lsSet("session", null);
  $("done-text").value = "";
  renderView();
}

function abortTimer() {
  const note = useShortcut() ? "\nショートカットで作ったリマインダー（またはタイマー）は自分で消してください。" : "";
  if (confirm(`中止しますか？ この30分は記録されません。${note}`)) endSession();
}

async function saveSession() {
  await putRecords([{
    id: newId(session.start),
    start: session.start,
    end: endTime(),
    min: DUR / 60,
    cat: pickedCat,
    text: $("done-text").value.trim(),
  }]);
  await loadRecords();
  lsSet("lastCat", pickedCat);
  endSession();
}

const RING_LEN = 2 * Math.PI * 88;
$("ring-fg").style.strokeDasharray = RING_LEN;

function renderTimer() {
  if (!session) {
    showTimerPart("idle");
    $("start-hint").textContent = TEST_SEC ? "試験モードではショートカットを呼びません。"
      : useShortcut() ? `スタートすると、ショートカット「${scName}」で 30分後に知らせます。`
      : "ショートカットが未設定です。30分後の知らせはありません（設定で名前を入れてください）。";
    return;
  }
  const secs = elapsedSec();
  if (secs >= DUR) {
    if ($("timer-done").hidden) {
      showTimerPart("done");
      $("done-range").textContent = `${dateLabel(session.start)} ${hhmm(session.start)}〜${hhmm(endTime())}`;
      renderChips($("cat-chips"), pickedCat, id => { pickedCat = id; });
    }
    return;
  }
  showTimerPart("running");
  const remain = Math.ceil(DUR - secs);
  $("remain").textContent = `${Math.floor(remain / 60)}:${pad2(remain % 60)}`;
  $("run-range").textContent = `${hhmm(session.start)}〜${hhmm(endTime())}`;
  $("ring-fg").style.strokeDashoffset = RING_LEN * (secs / DUR);
}

/* ---------- 記録の一覧 ---------- */
function recordList(list) {
  const ul = el("ul", "rec-list");
  for (const r of list) {
    const li = el("li");
    const top = el("div", "rec-top");
    top.append(dot(catColor(r.cat)), `${catName(r.cat)}　${hhmm(r.start)}〜${hhmm(r.end)}`);
    li.append(top);
    if (r.text) li.append(el("div", "rec-text", r.text));
    li.onclick = () => openEditor(r);
    ul.append(li);
  }
  return ul;
}

function renderToday() {
  const box = $("today-summary");
  const key = dayKey(Date.now());
  const list = records.filter(r => dayKey(r.start) === key);
  box.textContent = "";
  box.append(el("h3", null, `今日：${list.length}回（${fmtDur(sumMin(list))}）`));
  box.append(list.length ? recordList(list) : el("p", "hint", "まだ記録がありません。"));
}

/* ---------- 記録の追加・編集 ---------- */
function setMin(min) {
  $("edit-min").value = min;
  $("edit-quick").querySelectorAll(".chip").forEach(c => c.classList.toggle("on", Number(c.dataset.min) === Number(min)));
}

/** rec が null なら追加。dateKey を渡すとその日付で始める */
function openEditor(rec, dateKey) {
  const dlg = $("dlg-edit");
  let cat = rec ? rec.cat : pickedCat;
  // 追加のときの開始時刻は「今から30分前」を5分単位に丸めたもの
  const base = rec ? rec.start : Math.floor((Date.now() - 30 * 60000) / 300000) * 300000;
  $("edit-title").textContent = rec ? "記録を編集" : "記録を追加";
  $("edit-date").value = dateKey || dayKey(base);
  $("edit-time").value = `${pad2(new Date(base).getHours())}:${pad2(new Date(base).getMinutes())}`;
  setMin(rec ? Math.round(rec.min) : 30);
  renderChips($("edit-chips"), cat, id => { cat = id; });
  $("edit-text").value = rec ? rec.text || "" : "";
  $("edit-delete").hidden = !rec;

  dlg.onclose = async () => {
    if (dlg.returnValue === "save") {
      const [y, mo, d] = $("edit-date").value.split("-").map(Number);
      const [h, mi] = $("edit-time").value.split(":").map(Number);
      const start = new Date(y, mo - 1, d, h, mi).getTime();
      const min = Math.max(1, Math.round(Number($("edit-min").value) || 30));
      await putRecords([{
        id: rec ? rec.id : newId(start),
        start, end: start + min * 60000, min, cat,
        text: $("edit-text").value.trim(),
      }]);
      if (!rec) { pickedCat = cat; lsSet("lastCat", cat); }
    } else if (dlg.returnValue === "delete") {
      if (!confirm("この記録を削除しますか？")) return;
      await deleteRecord(rec.id);
    } else return;
    await loadRecords();
    renderView();
  };
  dlg.returnValue = "";
  dlg.showModal();
}

/* ---------- カレンダー ---------- */
const now0 = new Date();
let calY = now0.getFullYear(), calM = now0.getMonth(), calSel = null;

function groupByDay(list) {
  const m = new Map();
  for (const r of list) {
    const k = dayKey(r.start);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

const heatClass = n => (n >= 5 ? "h4" : n >= 3 ? "h3" : n === 2 ? "h2" : n === 1 ? "h1" : "");

function renderCal() {
  $("cal-title").textContent = `${calY}年${calM + 1}月`;
  const grid = $("cal-grid");
  grid.textContent = "";
  WEEKDAYS.forEach((w, i) => grid.append(el("div", "cal-head" + (i === 0 ? " sun" : ""), w)));

  const first = new Date(calY, calM, 1);
  const days = new Date(calY, calM + 1, 0).getDate();
  const byDay = groupByDay(records);
  const todayKey = dayKey(Date.now());
  for (let i = 0; i < first.getDay(); i++) grid.append(el("div", "cal-cell empty"));

  const monthList = [];
  for (let d = 1; d <= days; d++) {
    const key = dayKey(new Date(calY, calM, d));
    const list = byDay.get(key) || [];
    monthList.push(...list);
    const cell = el("button", `cal-cell ${heatClass(list.length)}`);
    if (key === todayKey) cell.classList.add("today");
    if (key === calSel) cell.classList.add("sel");
    cell.append(el("span", null, String(d)), el("span", "n", list.length ? String(list.length) : ""));
    cell.onclick = () => { calSel = key; renderCal(); };
    grid.append(cell);
  }
  $("cal-month-sum").textContent = `この月：${monthList.length}回・${fmtDur(sumMin(monthList))}`;

  const box = $("cal-day");
  box.hidden = !calSel || !calSel.startsWith(`${calY}-${pad2(calM + 1)}`);
  if (box.hidden) return;
  const list = byDay.get(calSel) || [];
  $("cal-day-title").textContent = `${dateLabel(keyToTime(calSel))}：${list.length}回（${fmtDur(sumMin(list))}）`;
  $("cal-day-list").replaceChildren(list.length ? recordList(list) : el("p", "hint", "記録はありません。"));
}

function moveCal(step) {
  calM += step;
  if (calM < 0) { calM = 11; calY--; }
  if (calM > 11) { calM = 0; calY++; }
  renderCal();
}

/* ---------- 統計 ---------- */
let stPeriod = "month";
let stAnchor = Date.now();

function dayBuckets(from, count) {
  return [...Array(count)].map((_, i) => {
    const t = addDays(from, i);
    return { from: t, to: addDays(t, 1), long: dateLabel(t) };
  });
}

function monthBuckets(y0, m0, count) {
  return [...Array(count)].map((_, i) => {
    const f = new Date(y0, m0 + i, 1);
    return { from: f.getTime(), to: new Date(y0, m0 + i + 1, 1).getTime(),
      label: `${f.getMonth() + 1}月`, long: `${f.getFullYear()}年${f.getMonth() + 1}月` };
  });
}

/** 期間の見出しと棒の区切り（buckets）を返す */
function periodRange() {
  const a = new Date(stAnchor);
  if (stPeriod === "week") {
    const mon = addDays(startOfDay(stAnchor), -((a.getDay() + 6) % 7)); // 月曜はじまり
    const buckets = dayBuckets(mon, 7).map(b => ({ ...b, label: WEEKDAYS[new Date(b.from).getDay()] }));
    return { title: `${dateLabel(mon)}〜${dateLabel(addDays(mon, 6))}`, buckets };
  }
  if (stPeriod === "month") {
    const y = a.getFullYear(), m = a.getMonth();
    const buckets = dayBuckets(new Date(y, m, 1).getTime(), new Date(y, m + 1, 0).getDate());
    return { title: `${y}年${m + 1}月`, buckets };
  }
  if (stPeriod === "year") {
    return { title: `${a.getFullYear()}年`, buckets: monthBuckets(a.getFullYear(), 0, 12) };
  }
  // 全期間: 最初の記録の月から今月まで
  const f = new Date(records.length ? records[0].start : Date.now()), n = new Date();
  const count = (n.getFullYear() - f.getFullYear()) * 12 + n.getMonth() - f.getMonth() + 1;
  return { title: "全期間", buckets: monthBuckets(f.getFullYear(), f.getMonth(), Math.max(1, count)) };
}

function moveStats(step) {
  const a = new Date(stAnchor);
  if (stPeriod === "week") stAnchor = addDays(stAnchor, 7 * step);
  else if (stPeriod === "month") stAnchor = new Date(a.getFullYear(), a.getMonth() + step, 1).getTime();
  else if (stPeriod === "year") stAnchor = new Date(a.getFullYear() + step, 0, 1).getTime();
  renderStats();
}

/** 棒グラフ（1系列）。タップした棒の値を cap に出す */
function barChart(box, axis, cap, items, axisLabels) {
  box.textContent = "";
  const max = Math.max(0, ...items.map(it => it.min));
  const defaultCap = max > 0 ? `最大 ${fmtDur(max)}（棒をタップで値）` : "記録がありません";
  cap.textContent = defaultCap;
  for (const it of items) {
    const col = el("div", "bar-col");
    const b = el("div", "b");
    b.style.height = `${max ? (it.min / max) * 100 : 0}%`;
    col.append(b);
    col.onclick = () => {
      const wasSel = col.classList.contains("sel");
      box.querySelectorAll(".bar-col").forEach(c => c.classList.remove("sel"));
      if (!wasSel) col.classList.add("sel");
      cap.textContent = wasSel ? defaultCap : `${it.long}：${fmtDur(it.min)}（${it.n}回）`;
    };
    box.append(col);
  }
  axis.replaceChildren(...axisLabels.map(l => el("span", null, l)));
}

function streaks() {
  const days = new Set(records.map(r => dayKey(r.start)));
  let longest = 0, run = 0, prevKey = null;
  for (const k of [...days].sort()) {
    run = prevKey && dayKey(addDays(keyToTime(prevKey), 1)) === k ? run + 1 : 1;
    longest = Math.max(longest, run);
    prevKey = k;
  }
  // 今日まだでも、昨日まで続いていれば「現在」に数える
  let cur = 0;
  let t = startOfDay(Date.now());
  if (!days.has(dayKey(t))) t = addDays(t, -1);
  while (days.has(dayKey(t))) { cur++; t = addDays(t, -1); }
  return { cur, longest };
}

function renderStats() {
  document.querySelectorAll("#stats-seg button").forEach(b => b.classList.toggle("on", b.dataset.p === stPeriod));
  const { title, buckets } = periodRange();
  $("st-title").textContent = title;
  $("st-prev").disabled = $("st-next").disabled = stPeriod === "all";

  const from = buckets[0].from, to = buckets[buckets.length - 1].to;
  const list = records.filter(r => r.start >= from && r.start < to);
  const total = sumMin(list);
  const activeDays = new Set(list.map(r => dayKey(r.start))).size;
  $("t-hours").textContent = fmtDur(total);
  $("t-count").textContent = `${list.length}回`;
  $("t-days").textContent = `${activeDays}日`;
  $("t-avg").textContent = activeDays ? fmtDur(total / activeDays) : "—";

  // 推移
  const items = buckets.map(b => {
    const inB = list.filter(r => r.start >= b.from && r.start < b.to);
    return { min: sumMin(inB), n: inB.length, long: b.long };
  });
  const axis = buckets.length <= 12 ? buckets.map(b => b.label || b.long)
    : [0, Math.floor(buckets.length / 2), buckets.length - 1].map(i => buckets[i].long.replace(/（.）/, ""));
  barChart($("bar-chart"), $("bar-axis"), $("bar-cap"), items, axis);

  // 分類別（多い順）
  const byCat = new Map();
  for (const r of list) byCat.set(r.cat, (byCat.get(r.cat) || 0) + r.min);
  const box = $("cat-breakdown");
  box.textContent = "";
  if (!byCat.size) box.append(el("p", "hint", "記録がありません。"));
  for (const [id, min] of [...byCat].sort((x, y) => y[1] - x[1])) {
    const pct = (min / total) * 100;
    const top = el("div", "cat-row-top");
    const name = el("span");
    name.append(dot(catColor(id)), ` ${catName(id)}`);
    top.append(name, el("span", "v", `${fmtDur(min)}（${Math.round(pct)}%）`));
    const fill = el("div", "cat-fill");
    fill.style.width = `${pct}%`;
    fill.style.background = catColor(id);
    const track = el("div", "cat-track");
    track.append(fill);
    const row = el("div", "cat-row");
    row.append(top, track);
    box.append(row);
  }

  // 時間帯
  const hours = [...Array(24)].map((_, h) => ({ min: 0, n: 0, long: `${h}時台` }));
  for (const r of list) { const h = new Date(r.start).getHours(); hours[h].min += r.min; hours[h].n++; }
  barChart($("hour-chart"), $("hour-axis"), $("hour-cap"), hours, ["0時", "6時", "12時", "18時", "23時"]);

  const s = streaks();
  $("streak").textContent = `現在 ${s.cur}日連続 ／ 最長 ${s.longest}日`;
}

/* ---------- 設定 ---------- */
function renderSettings() {
  $("sc-name").value = scName;
  const ul = $("cat-list");
  ul.textContent = "";
  const used = new Set(records.map(r => r.cat));
  for (const c of cats) {
    const ren = el("button", null, "名前を変える");
    ren.onclick = () => {
      const name = (prompt("新しい名前", c.name) || "").trim();
      if (!name) return;
      c.name = name;
      saveCats();
      renderView();
    };
    const del = el("button", null, "削除");
    del.onclick = () => {
      if (used.has(c.id)) { alert("この分類の記録があるので削除できません。名前を変えてください。"); return; }
      if (cats.length <= 1 || !confirm(`「${c.name}」を削除しますか？`)) return;
      cats = cats.filter(x => x !== c);
      if (pickedCat === c.id) pickedCat = cats[0].id;
      saveCats();
      renderView();
    };
    const li = el("li");
    li.append(dot(slotColor(c.slot)), el("span", "name", c.name), ren, del);
    ul.append(li);
  }
  renderInfo();
}

function addCat() {
  const name = $("cat-new").value.trim();
  if (!name) return;
  if (cats.some(c => c.name === name)) { alert("同じ名前の分類があります。"); return; }
  cats.push({ id: `c${Date.now()}`, name, slot: freeSlot() });
  saveCats();
  $("cat-new").value = "";
  renderView();
}

async function exportJson() {
  const body = JSON.stringify({ app: "katsu", version: 1, exported: new Date().toISOString(), cats, records }, null, 1);
  const name = `katsu_${dayKey(Date.now())}.json`;
  const file = new File([body], name, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch { /* 取り消し */ }
    return;
  }
  const a = el("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "katsu" || !Array.isArray(data.records)) throw new Error("形式が違います");
    for (const c of data.cats || []) if (!catById(c.id)) cats.push(c);
    saveCats();
    const have = new Set(records.map(r => r.id));
    const add = data.records.filter(r => !have.has(r.id));
    await putRecords(add);
    await loadRecords();
    alert(`${add.length}件を読み込みました（重複 ${data.records.length - add.length}件は飛ばしました）。`);
    renderView();
  } catch (e) {
    alert(`読み込めませんでした：${e.message}`);
  }
}

let persisted = "未確認";
function renderInfo() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  $("info").textContent = [
    `版: ${VERSION}${TEST_SEC ? `（試験モード ${TEST_SEC}秒）` : ""}`,
    `ホーム画面から起動: ${standalone ? "はい" : "いいえ（Safari のタブ）"}`,
    `保存の固定(persist): ${persisted}`,
    `記録: ${records.length}件`,
  ].join("\n");
}

/* ---------- タブ ---------- */
let view = "timer";
function showView(v) {
  view = v;
  document.querySelectorAll(".view").forEach(s => { s.hidden = s.id !== `view-${v}`; });
  document.querySelectorAll(".tabbar button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  renderView();
}

function renderView() {
  if (view === "timer") { renderTimer(); renderToday(); }
  else if (view === "cal") renderCal();
  else if (view === "stats") renderStats();
  else renderSettings();
}

/* ---------- つなぎ込み ---------- */
function bind() {
  $("btn-start").onclick = startTimer;
  $("btn-abort").onclick = abortTimer;
  $("btn-save").onclick = saveSession;
  $("btn-discard").onclick = () => { if (confirm("この30分を記録せずに捨てますか？")) endSession(); };
  document.querySelectorAll("[data-add]").forEach(b => {
    b.onclick = () => openEditor(null, b.dataset.add === "cal" ? calSel : null);
  });
  $("edit-quick").querySelectorAll(".chip").forEach(c => { c.onclick = () => setMin(c.dataset.min); });
  $("edit-min").oninput = () => setMin($("edit-min").value);
  $("cal-prev").onclick = () => moveCal(-1);
  $("cal-next").onclick = () => moveCal(1);
  $("st-prev").onclick = () => moveStats(-1);
  $("st-next").onclick = () => moveStats(1);
  document.querySelectorAll("#stats-seg button").forEach(b => {
    b.onclick = () => { stPeriod = b.dataset.p; stAnchor = Date.now(); renderStats(); };
  });
  document.querySelectorAll(".tabbar button").forEach(b => { b.onclick = () => showView(b.dataset.v); });
  $("sc-save").onclick = () => { scName = $("sc-name").value.trim(); lsSet("shortcut", scName); alert("保存しました。"); };
  $("cat-add").onclick = addCat;
  $("btn-export").onclick = exportJson;
  $("file-import").onchange = e => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ""; };

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") renderView(); });
  darkMq.addEventListener("change", renderView);
  setInterval(() => { if (view === "timer" && session) renderTimer(); }, 250);
}

async function main() {
  if (TEST_SEC) {
    $("test-banner").hidden = false;
    $("test-banner").textContent = `試験モード：${TEST_SEC}秒で終わります。記録は本番とは別の場所に保存されます。`;
  }
  if (!catById(pickedCat)) pickedCat = cats[0].id;
  bind();
  db = await openDb();
  await loadRecords();
  renderView();
  if (navigator.storage && navigator.storage.persist) {
    try { persisted = (await navigator.storage.persist()) ? "はい" : "いいえ"; } catch { persisted = "失敗"; }
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

main();
