/* ===================================================================
   Media BMSTU — Рейтинг семестра
   Данные берутся напрямую из Google Таблицы (gviz JSON через JSONP —
   работает и с file://, без сервера, в том числе на Android).
   Обновление раз в сутки без перезагрузки.
   =================================================================== */

const CONFIG = {
  SHEET_ID: "1cPFCRkBSb_R25b5ZB2aJvK32gd0WUNa0Rx2VriAW0Wo",
  GID: "737335544",                 // лист «Тир листы»
  REFRESH_HOUR: 4,                  // во сколько часов делать суточное обновление (локальное время)
  POLL_MS: 6 * 60 * 60 * 1000,      // как часто перепроверять (страховка), 6 ч
  KIOSK_SPEED: 0.4,                 // px за тик авто-прокрутки

  // ---- Кино-режим (авто-переключение видов, без единого клика) ----
  UI_SCALE: 0.8,                      // масштаб интерфейса (меньше = мельче, больше влезает). Клавиши -/+
  CINEMA_ENABLED: true,
  CINEMA_INTERVAL_MS: 30 * 60 * 1000, // раз в 30 мин запускать показ по отделам
  SPOTLIGHT_MS: 30 * 1000,            // 30 сек на каждый отдел
  FADE_MS: 500,                       // плавность смены вида
};

// Красивые названия отделов + иконки. Подбираются по подстроке из заголовка
// таблицы, поэтому если в таблице переименуют/добавят отдел — всё подхватится.
const DEPT_STYLE = [
  { match: "ВИДИК",  name: "Видео",          icon: "🎬" },
  { match: "ПРОДИК", name: "Прод",           icon: "🎯" },
  { match: "ОВЭШ",   name: "VFX",            icon: "✨" },
  { match: "SMM",    name: "SMM",            icon: "💬" },
  { match: "ДИЗАЙН", name: "Дизайн",         icon: "🎨" },
  { match: "ФОТИК",  name: "Фото",           icon: "📷" },
  { match: "ПРОЕКТ", name: "Проектный",      icon: "🚀" },
];

const state = {
  departments: [],     // [{key,name,icon,members:[{name,score}]}]
  filter: "all",       // "all" | dept.key
  search: "",
  lastData: null,      // snapshot для диффа { deptKey: { name: score } }
  lastUpdated: null,   // Date
  kiosk: false,
  scale: 1,
};

/* ----------------------------- утилиты ----------------------------- */

const $ = (sel) => document.querySelector(sel);

// URL CSV-экспорта таблицы. CSV отдаёт ВСЁ текстом — gviz-JSON же
// типизирует колонки и обнуляет текстовый заголовок в числовых rank-колонках
// (у SMM и Проектного ранги — простые числа), из-за чего отделы пропадали.
function sheetUrl() {
  const t = Date.now(); // cache-buster
  return `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&gid=${CONFIG.GID}&_=${t}`;
}

// Парсер CSV с поддержкой кавычек и запятых внутри полей
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// "18,45" -> 18.45 ; "" -> null
function toNumber(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(",", ".").replace(/\s/g, "");
  if (s === "") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// форматирование балла для показа (русский стиль, запятая)
function fmtScore(n) {
  if (n == null) return "0";
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace(".", ",");
}

function styleFor(header) {
  const up = header.toUpperCase();
  const found = DEPT_STYLE.find((d) => up.includes(d.match));
  if (found) return found;
  // запасной вариант: чистим «СЕМЕСТРА» из заголовка
  const clean = header.replace(/СЕМЕСТРА/i, "").trim();
  return { name: clean || header, icon: "⭐" };
}

/* --------------------- разбор таблицы в отделы --------------------- */

function parseDepartments(rows) {
  if (!rows.length) return [];
  const header = rows[0];
  const blocks = [];
  for (let c = 0; c < header.length; c++) {
    const title = (header[c] || "").trim();
    if (title) {
      const st = styleFor(title);
      blocks.push({
        rankCol: c, nameCol: c + 1, scoreCol: c + 2,
        rawTitle: title,
        key: title.toUpperCase().replace(/[^A-ZА-Я0-9]/gi, "").slice(0, 24) || `d${c}`,
        name: st.name, icon: st.icon,
        members: [],
      });
    }
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    for (const b of blocks) {
      const name = (row[b.nameCol] || "").trim();
      if (!name) continue;
      const score = toNumber(row[b.scoreCol]);
      b.members.push({ name, score: score == null ? 0 : score });
    }
  }

  // сортируем по баллам убыв., присваиваем место
  for (const b of blocks) {
    b.members.sort((a, z) => z.score - a.score || a.name.localeCompare(z.name, "ru"));
    b.maxScore = b.members.reduce((m, x) => Math.max(m, x.score), 0) || 1;
    b.members.forEach((m, i) => (m.rank = i + 1));
  }
  return blocks;
}

/* --------------------------- загрузка ------------------------------ */

async function loadData(isAuto = false) {
  try {
    const res = await fetch(sheetUrl(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = parseCSV(await res.text());
    const depts = parseDepartments(rows);
    if (!depts.length) throw new Error("Пустые данные");

    const changes = diffAgainstLast(depts);
    const newLeaders = detectLeaderChanges(depts);  // смена #1 с прошлого раза
    computeWeeklyMovement(depts);                    // проставляет m.weekMove
    state.departments = depts;
    state.lastUpdated = new Date();
    snapshot(depts);
    recordDailySnapshot(depts);                      // снимок на сегодня для недельной динамики

    render(changes);
    hideLoader();
    updateStatus();

    if (isAuto) showToast("Рейтинг обновлён ✓");

    // празднуем новых лидеров отделов (конфетти + подсветка)
    newLeaders.forEach((L, i) =>
      setTimeout(() => celebrateLeader(L), 500 + i * 400));
  } catch (err) {
    console.error("Ошибка загрузки:", err);
    if (!state.departments.length) {
      hideLoader();
      $("#board").innerHTML =
        `<div class="empty">Не удалось загрузить данные из таблицы.<br>` +
        `Проверьте интернет и доступ к Google Таблице.<br>` +
        `<small style="color:var(--muted-2)">${String(err.message || err)}</small></div>`;
    } else {
      showToast("Не удалось обновить — показаны прежние данные");
    }
  }
}

/* ------------------- дифф для подсветки изменений ------------------ */

function snapshot(depts) {
  const snap = {};
  for (const d of depts) {
    snap[d.key] = {};
    for (const m of d.members) snap[d.key][m.name] = { score: m.score, rank: m.rank };
  }
  state.lastData = snap;
}

function diffAgainstLast(depts) {
  const prev = state.lastData;
  const changes = {}; // key -> { name -> {scoreDelta, rankDelta} }
  if (!prev) return changes;
  for (const d of depts) {
    changes[d.key] = {};
    const pd = prev[d.key] || {};
    for (const m of d.members) {
      const p = pd[m.name];
      if (!p) continue;
      const scoreDelta = m.score - p.score;
      const rankDelta = p.rank - m.rank; // >0 поднялся
      if (scoreDelta !== 0 || rankDelta !== 0) {
        changes[d.key][m.name] = { scoreDelta, rankDelta };
      }
    }
  }
  return changes;
}

/* ----------------------------- рендер ------------------------------ */

function visibleDepartments() {
  if (state.filter === "all") return state.departments;
  return state.departments.filter((d) => d.key === state.filter);
}

function render(changes = {}) {
  renderChips();
  const board = $("#board");
  const single = state.filter !== "all";
  board.classList.toggle("single", single);
  board.classList.toggle("spotlight-mode", single);

  const q = state.search.trim().toLowerCase();
  const depts = visibleDepartments();
  board.innerHTML = "";
  board.style.gridTemplateColumns = "";

  if (single && depts.length) {
    renderSpotlight(depts[0], q);
  } else if (!single) {
    board.style.gridTemplateColumns =
      `repeat(${state.departments.length}, minmax(0, 1fr))`;
    renderAll(depts, q, changes);
  }

  if (!board.childElementCount) {
    board.innerHTML =
      `<div class="empty">Ничего не найдено${q ? ` по запросу «${esc(state.search)}»` : ""}.</div>`;
    return;
  }

  // анимации: заполнение полосок (через transform — на GPU, без лагов)
  // и единый count-up баллов одним циклом вместо сотен параллельных
  const fillBars = () => document.querySelectorAll(".bar i").forEach((el) => {
    el.style.transform = "scaleX(" + (parseFloat(el.dataset.w) / 100) + ")";
  });
  const scores = [...document.querySelectorAll(".score")]
    .map((el) => ({ el, target: parseFloat(el.dataset.score) }));

  if (document.hidden) {
    // вкладка скрыта — rAF на паузе; ставим финальные значения сразу,
    // чтобы при разворачивании окна не было нулей
    fillBars();
    scores.forEach((it) => (it.el.textContent = fmtScore(it.target)));
  } else {
    requestAnimationFrame(() => { fillBars(); runCountUps(scores); });
  }
}

// вид «все отделы в строчку»
function renderAll(depts, q, changes) {
  const board = $("#board");
  depts.forEach((d, di) => {
    let members = d.members;
    if (q) members = members.filter((m) => m.name.toLowerCase().includes(q));
    if (!members.length) return;

    const card = document.createElement("section");
    card.className = "card";
    card.dataset.key = d.key;
    card.style.animationDelay = (di * 0.06) + "s";

    const head = document.createElement("div");
    head.className = "card-head";
    head.innerHTML =
      `<div class="card-ico">${d.icon}</div>
       <div class="card-title">
         <div class="card-name">${esc(d.name)}</div>
         <div class="card-meta">рейтинг семестра</div>
       </div>
       <div class="card-count">${d.members.length}</div>`;
    card.appendChild(head);

    const ul = document.createElement("ul");
    ul.className = "rows";
    const chg = changes[d.key] || {};
    members.forEach((m, idx) => {
      const changed = !!(chg[m.name] && chg[m.name].scoreDelta !== 0);
      ul.appendChild(buildRow("li", m, d, { changed }));
    });
    card.appendChild(ul);
    board.appendChild(card);
  });
}

// крупный экран одного отдела (для кино-режима)
function renderSpotlight(d, q) {
  const board = $("#board");
  let members = d.members;
  if (q) members = members.filter((m) => m.name.toLowerCase().includes(q));

  const idx = state.departments.findIndex((x) => x.key === d.key) + 1;
  const wrap = document.createElement("div");
  wrap.className = "spotlight";
  wrap.innerHTML =
    `<div class="spot-head">
       <div class="spot-ico">${d.icon}</div>
       <div class="spot-titles">
         <div class="spot-name">${esc(d.name)}</div>
         <div class="spot-sub">рейтинг семестра · ${d.members.length} участников</div>
       </div>
       <div class="spot-badge">${idx} / ${state.departments.length}</div>
     </div>`;

  const grid = document.createElement("div");
  grid.className = "spot-grid";
  members.forEach((m, i) =>
    grid.appendChild(buildRow("div", m, d, { animate: true, idx: i, spotlight: true })));
  wrap.appendChild(grid);
  board.appendChild(wrap);

  layoutSpotlight(grid, members.length);
}

// Подгоняем колонки под экран: ровно N целых строк в колонку (grid-строки),
// лишних людей (что не влезли) прячем — на витрине важнее верх рейтинга.
function layoutSpotlight(grid, count) {
  const ROW_H = 48, COL_W = 330, GAP = 26, BOTTOM = 18;
  const availW = grid.clientWidth || grid.parentElement.clientWidth;
  const colsFit = Math.max(1, Math.floor((availW + GAP) / (COL_W + GAP)));
  const top = grid.getBoundingClientRect().top;
  const availH = window.innerHeight - top - BOTTOM;
  const rowsPer = Math.max(1, Math.floor(availH / ROW_H));
  const need = Math.min(count, colsFit * rowsPer);

  grid.style.gridTemplateRows = `repeat(${rowsPer}, ${ROW_H}px)`;

  const rows = grid.children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].style.display = i < need ? "" : "none";
  }
}

// один ряд рейтинга (общий для обоих видов)
function buildRow(tag, m, d, opts = {}) {
  const el = document.createElement(tag);
  let cls = "row";
  if (opts.spotlight) cls += " spot-row";
  if (m.rank === 1) cls += " top1";
  else if (m.rank === 2) cls += " top2";
  else if (m.rank === 3) cls += " top3";
  if (opts.changed) cls += " changed";
  if (opts.animate) cls += " enter";
  el.className = cls;
  if (opts.animate) el.style.animationDelay = (Math.min(opts.idx || 0, 24) * 0.03) + "s";

  const pct = Math.max(3, (m.score / d.maxScore) * 100);
  let wmove = "";
  if (m.weekMove != null && m.weekMove !== 0) {
    const up = m.weekMove > 0;
    wmove = `<span class="wmove ${up ? "up" : "down"}" title="за неделю">${up ? "▲" : "▼"}${Math.abs(m.weekMove)}</span>`;
  }

  el.innerHTML =
    `<div class="rank">${m.rank}</div>
     <div class="person">
       <div class="person-line"><span class="pname">${esc(m.name)}</span>${wmove}</div>
       <div class="bar"><i data-w="${pct}"></i></div>
     </div>
     <div class="score" data-score="${m.score}">0</div>`;
  return el;
}

function renderChips() {
  const box = $("#deptChips");
  if (box.childElementCount && box.dataset.built === String(state.departments.length)) {
    box.querySelectorAll(".chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.key === state.filter));
    return;
  }
  box.dataset.built = String(state.departments.length);
  box.innerHTML = "";
  const all = chip("all", "🏆", "Все отделы");
  box.appendChild(all);
  state.departments.forEach((d) => box.appendChild(chip(d.key, d.icon, d.name)));
  box.querySelectorAll(".chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.key === state.filter));
}

function chip(key, ico, label) {
  const el = document.createElement("button");
  el.className = "chip";
  el.dataset.key = key;
  el.innerHTML = `<span class="chip-ico">${ico}</span>${esc(label)}`;
  el.addEventListener("click", () => {
    cinemaInterrupt();      // ручной выбор откладывает авто-показ
    setView(key);
  });
  return el;
}

function runCountUps(list) {
  if (!list.length) return;
  const dur = 850, start = performance.now();
  function step(now) {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    for (const it of list) it.el.textContent = fmtScore(it.target * eased);
    if (p < 1) requestAnimationFrame(step);
    else for (const it of list) it.el.textContent = fmtScore(it.target);
  }
  requestAnimationFrame(step);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* --------------------------- статус-бар ---------------------------- */

function updateStatus() {
  if (state.lastUpdated) {
    $("#lastUpdated").textContent = state.lastUpdated.toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  }
}

function nextRefreshDate() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(CONFIG.REFRESH_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function tickCountdown() {
  const next = nextRefreshDate();
  const ms = next - new Date();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  $("#nextUpdate").textContent =
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* --------------------- планировщик обновлений ---------------------- */

let lastRefreshDay = new Date().toDateString();

function scheduleDailyRefresh() {
  // Точечное обновление в заданный час + страховочный поллинг.
  setInterval(() => {
    const now = new Date();
    const isHour = now.getHours() === CONFIG.REFRESH_HOUR && now.getMinutes() === 0;
    const newDay = now.toDateString() !== lastRefreshDay;
    if (isHour && newDay) {
      lastRefreshDay = now.toDateString();
      loadData(true);
    }
  }, 30 * 1000);

  // страховка: если вкладку давно не трогали — обновим раз в POLL_MS
  setInterval(() => loadData(true), CONFIG.POLL_MS);

  // обновляем при возврате на вкладку, если прошли сутки
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.lastUpdated) {
      const ageH = (Date.now() - state.lastUpdated) / 3600000;
      if (ageH >= 20) loadData(true);
    }
  });
}

/* ------------------------------ тост ------------------------------- */

let toastTimer;
function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

function hideLoader() { $("#loader").classList.add("hide"); }

// Масштаб всего интерфейса. zoom меняет и вёрстку: при <1 в колонки влезает
// больше символов (фамилии не режутся на ТВ с мелким логическим разрешением).
function applyScale(v) {
  v = Math.min(1.3, Math.max(0.5, Math.round(v * 100) / 100));
  state.scale = v;
  // zoom на body (не html), высоту компенсируем, иначе при zoom<1 снизу пусто
  document.body.style.zoom = v;
  document.body.style.height = `calc(100vh / ${v})`;
  try { localStorage.setItem("mb_scale", v); } catch {}
  if (state.departments.length) render();
}

/* ---------------- недельная динамика (▲/▼ за неделю) --------------- */
// Раз в сутки сохраняем снимок мест в localStorage, а показываем движение
// относительно снимка недельной давности.

function loadSnaps() {
  try { return JSON.parse(localStorage.getItem("mb_snaps")) || []; }
  catch { return []; }
}
function saveSnaps(arr) {
  try { localStorage.setItem("mb_snaps", JSON.stringify(arr)); } catch {}
}
function recordDailySnapshot(depts) {
  const today = new Date().toISOString().slice(0, 10);
  let snaps = loadSnaps().filter((s) => s.date !== today);
  const ranks = {};
  for (const d of depts) {
    ranks[d.key] = {};
    d.members.forEach((m) => (ranks[d.key][m.name] = m.rank));
  }
  snaps.push({ date: today, ranks });
  saveSnaps(snaps.slice(-21)); // держим ~3 недели истории
}
function computeWeeklyMovement(depts) {
  const snaps = loadSnaps();
  const now = new Date();
  // берём снимок, ближайший к «неделе назад», но не моложе 6 дней
  let ref = null, best = Infinity;
  for (const s of snaps) {
    const age = (now - new Date(s.date)) / 86400000;
    if (age >= 6 && Math.abs(age - 7) < best) { best = Math.abs(age - 7); ref = s; }
  }
  for (const d of depts) {
    const old = ref ? (ref.ranks[d.key] || {}) : null;
    for (const m of d.members) {
      const o = old ? old[m.name] : null;
      m.weekMove = o == null ? null : o - m.rank; // >0 — поднялся
    }
  }
}

/* -------------- смена лидера отдела: конфетти + тост --------------- */

function detectLeaderChanges(depts) {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem("mb_leaders")) || {}; } catch {}
  const changed = [], next = {};
  for (const d of depts) {
    const top = d.members[0];
    if (!top) continue;
    next[d.key] = top.name;
    if (stored[d.key] != null && stored[d.key] !== top.name) {
      changed.push({ key: d.key, deptName: d.name, name: top.name });
    }
  }
  try { localStorage.setItem("mb_leaders", JSON.stringify(next)); } catch {}
  return changed;
}

function celebrateLeader(L) {
  confettiBurst();
  showToast(`👑 Новый лидер · ${L.deptName}: ${L.name}`);
  const card = document.querySelector(`.card[data-key="${cssAttr(L.key)}"]`);
  if (card) {
    card.classList.add("celebrate");
    setTimeout(() => card.classList.remove("celebrate"), 4200);
  }
}
function cssAttr(v) { return String(v).replace(/["\\]/g, "\\$&"); }

let confettiCanvas = null;
function confettiBurst() {
  if (!confettiCanvas) {
    confettiCanvas = document.createElement("canvas");
    confettiCanvas.id = "confetti";
    document.body.appendChild(confettiCanvas);
  }
  const c = confettiCanvas, ctx = c.getContext("2d");
  const W = (c.width = window.innerWidth), H = (c.height = window.innerHeight);
  const colors = ["#43ed4e", "#2fae39", "#ffd24a", "#ffffff", "#a7f3ac"];
  const P = [];
  for (let i = 0; i < 150; i++) {
    P.push({
      x: W / 2 + (Math.random() - 0.5) * W * 0.5,
      y: H * 0.32 + Math.random() * 40,
      vx: (Math.random() - 0.5) * 11,
      vy: Math.random() * -13 - 4,
      g: 0.28 + Math.random() * 0.12,
      s: 6 + Math.random() * 7,
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
      col: colors[(Math.random() * colors.length) | 0],
    });
  }
  c.style.opacity = "1";
  const start = performance.now(), dur = 2600;
  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    for (const p of P) {
      p.vy += p.g; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - t / dur);
      ctx.fillStyle = p.col;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
      ctx.restore();
    }
    if (t < dur) requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, W, H); c.style.opacity = "0"; }
  }
  requestAnimationFrame(frame);
}

/* ------------------- плавная смена вида + кино-режим --------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let viewFadeTimer = null;

function setView(key) {
  if (state.filter === key) return;
  const board = $("#board");
  board.classList.add("view-fade");
  clearTimeout(viewFadeTimer);
  viewFadeTimer = setTimeout(() => {
    state.filter = key;
    render();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => board.classList.remove("view-fade")));
  }, CONFIG.FADE_MS);
}

const cinema = { idleTimer: null, running: false, stop: false };
function cinemaScheduleIdle() {
  clearTimeout(cinema.idleTimer);
  cinema.idleTimer = setTimeout(cinemaRun, CONFIG.CINEMA_INTERVAL_MS);
}
async function cinemaRun() {
  if (cinema.running || !state.departments.length) { cinemaScheduleIdle(); return; }
  cinema.running = true; cinema.stop = false;
  for (const d of state.departments) {
    if (cinema.stop) break;
    setView(d.key);
    await sleep(CONFIG.SPOTLIGHT_MS);
  }
  if (!cinema.stop) setView("all");
  cinema.running = false;
  cinemaScheduleIdle();
}
function cinemaInterrupt() {
  cinema.stop = true;
  cinemaScheduleIdle();
}

/* ----------------------- режим авто-экрана ------------------------- */

let kioskRAF = null, kioskDir = 1;
function toggleKiosk() {
  state.kiosk = !state.kiosk;
  $("#kioskBtn").classList.toggle("active", state.kiosk);
  if (state.kiosk) kioskLoop();
  else if (kioskRAF) cancelAnimationFrame(kioskRAF);
}
function kioskLoop() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  if (max > 4) {
    let y = window.scrollY + CONFIG.KIOSK_SPEED * kioskDir;
    if (y >= max) { y = max; kioskDir = -1; }
    else if (y <= 0) { y = 0; kioskDir = 1; }
    window.scrollTo(0, y);
  }
  if (state.kiosk) kioskRAF = requestAnimationFrame(kioskLoop);
}

/* ------------------------------ старт ------------------------------ */

function init() {
  $("#refreshBtn").addEventListener("click", () => {
    const btn = $("#refreshBtn");
    btn.classList.add("spin");
    loadData(false).finally(() => setTimeout(() => btn.classList.remove("spin"), 700));
  });

  let searchTimer;
  $("#searchInput").addEventListener("input", (e) => {
    state.search = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => render(), 160);
  });

  $("#kioskBtn").addEventListener("click", toggleKiosk);

  // Полный экран (для Android TV / браузера). Кнопка сама прячется в fullscreen.
  $("#fsBtn").addEventListener("click", () => {
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  });
  const syncFs = () => {
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    document.body.classList.toggle("is-fs", on);
  };
  document.addEventListener("fullscreenchange", syncFs);
  document.addEventListener("webkitfullscreenchange", syncFs);

  // Горячие клавиши (для проверки на ноутбуке и ручного управления):
  //   C — запустить показ по отделам прямо сейчас
  //   A / Esc / 0 — вернуться к «все отделы»
  //   1…7 — сразу открыть крупный экран нужного отдела
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    const k = e.key.toLowerCase();
    if (k === "c") { cinemaInterrupt(); cinemaRun(); }
    else if (k === "a" || k === "escape" || k === "0") { cinemaInterrupt(); setView("all"); }
    else if (k === "-" || k === "_") applyScale(state.scale - 0.05);
    else if (k === "+" || k === "=") applyScale(state.scale + 0.05);
    else if (k >= "1" && k <= "9") {
      const d = state.departments[+k - 1];
      if (d) { cinemaInterrupt(); setView(d.key); }
    }
  });

  // масштаб интерфейса (мельче = больше влезает; клавиши -/+ подстраивают, сохраняется)
  const saved = parseFloat(localStorage.getItem("mb_scale"));
  applyScale(Number.isFinite(saved) ? saved : CONFIG.UI_SCALE);

  loadData(false);
  scheduleDailyRefresh();
  tickCountdown();
  setInterval(tickCountdown, 1000);

  // кино-режим: сам, без кликов, раз в 30 мин показывает отделы по очереди
  if (CONFIG.CINEMA_ENABLED) cinemaScheduleIdle();
}

document.addEventListener("DOMContentLoaded", init);
