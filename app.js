'use strict';

/* =====================================================================
   Stock pellets — PWA 100 % locale (localStorage), aucune dépendance.
   Modèle : une liste d'événements
     open      : un sac ouvert  (ts, brand, price, tempExt, tempInt, note, noDeduct?)
     delivery  : livraison      (ts, bags, total, pricePerBag, note)
     adjust    : ajustement     (ts, delta, note)
   Stock = stock initial + livraisons + ajustements − sacs ouverts (hors sac initial).
   ===================================================================== */

const KEY = 'pellets.v1';
const DAY = 86400000;
const HOUR = 3600000;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const num = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

let S = load();
let tab = 'home';
let period = 'week';
let locked = false;
let ignorePop = false;
let deferredInstall = null;
let toastTimer = null;

/* ---------------------------- Persistance ---------------------------- */
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.events) && d.settings) return d;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(S));
  } catch (e) {
    toast("Impossible d'enregistrer (stockage plein ou bloqué).");
  }
}

/* ----------------------------- Formats ------------------------------- */
const thisYear = () => new Date().getFullYear();
function fmtDate(ts, long = false) {
  const d = new Date(ts);
  const o = long
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : { weekday: 'short', day: 'numeric', month: 'short' };
  if (!long && d.getFullYear() !== thisYear()) o.year = 'numeric';
  return d.toLocaleDateString('fr-FR', o);
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtDT = (ts) => `${fmtDate(ts)} · ${fmtTime(ts)}`;
const fmtShort = (ts) => new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'numeric' });

function fmtDur(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mi = m % 60;
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${String(mi).padStart(2, '0')}`;
  return `${mi} min`;
}
const fmtEur = (n) => (n == null ? '—' : n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }));
const fmtNum = (n, d = 1) => (n == null || Number.isNaN(n) ? '—' : n.toLocaleString('fr-FR', { maximumFractionDigits: d }));
const fmtTemp = (t) => (t == null ? '' : `${fmtNum(t, 1)} °C`);

function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromInput(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}
const ymd = (ts) => toLocalInput(ts).slice(0, 10);

/* ------------------------------ Calculs ------------------------------ */
function opens() {
  return S.events.filter((e) => e.type === 'open').sort((a, b) => a.ts - b.ts);
}

function bags() {
  const o = opens();
  return o.map((e, i) => ({ ev: e, n: i + 1, start: e.ts, end: o[i + 1] ? o[i + 1].ts : null }));
}

function stockNow() {
  let s = Number(S.settings.initialStock) || 0;
  for (const e of S.events) {
    if (e.type === 'delivery') s += Number(e.bags) || 0;
    else if (e.type === 'adjust') s += Number(e.delta) || 0;
    else if (e.type === 'open' && !e.noDeduct) s -= 1;
  }
  return s;
}

function defaultBagPrice() {
  const s = S.settings;
  return s.palettePrice > 0 && s.bagsPerPalette > 0 ? s.palettePrice / s.bagsPerPalette : null;
}

// Prix du sac « du moment » : dernière livraison connue, sinon prix de la palette des réglages.
function currentBagPrice() {
  let best = null;
  for (const e of S.events) {
    if (e.type === 'delivery' && e.pricePerBag != null && e.ts <= Date.now() && (!best || e.ts > best.ts)) best = e;
  }
  return best ? best.pricePerBag : defaultBagPrice();
}

const bagPrice = (ev) => (ev.price != null ? ev.price : defaultBagPrice());
const lastBrand = () => {
  const o = opens();
  for (let i = o.length - 1; i >= 0; i--) if (o[i].brand) return o[i].brand;
  return S.settings.brand || '';
};

function computeStats() {
  const now = Date.now();
  const bl = bags();
  const done = bl.filter((b) => b.end != null);
  const durs = done.map((b) => b.end - b.start);
  const avg = mean(durs);
  const recent = durs.slice(-10);
  const avgRecent = recent.length >= 3 ? mean(recent) : avg;
  const stock = stockNow();
  const cur = bl[bl.length - 1] || null;

  let remaining = null;
  let endDate = null;
  if (avgRecent && cur) {
    const curLeft = Math.max(0, avgRecent - (now - cur.start));
    remaining = Math.max(0, stock) * avgRecent + curLeft;
    endDate = now + remaining;
  }

  const prices = bl.map((b) => bagPrice(b.ev)).filter((p) => p != null);
  const totalCost = prices.length ? prices.reduce((a, b) => a + b, 0) : null;
  const avgPrice = prices.length ? totalCost / prices.length : null;
  const unitNow = currentBagPrice();
  const perWeek = avg ? (7 * DAY) / avg : null;
  const perMonth = avg ? (30.44 * DAY) / avg : null;

  return {
    now, bl, done, durs, avg, avgRecent, stock, cur, remaining, endDate,
    min: durs.length ? Math.min(...durs) : null,
    max: durs.length ? Math.max(...durs) : null,
    w7: bl.filter((b) => b.start > now - 7 * DAY).length,
    w30: bl.filter((b) => b.start > now - 30 * DAY).length,
    perWeek, perMonth,
    totalCost, avgPrice, unitNow,
    costMonth: perMonth && unitNow != null ? perMonth * unitNow : null,
    stockValue: unitNow != null ? Math.max(0, stock) * unitNow : null,
    since: bl.length ? bl[0].start : null
  };
}

/* ------------------------------ Météo -------------------------------- */
async function fetchTempExt() {
  const { lat, lon } = S.settings;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m`, { signal: ctl.signal });
    const j = await r.json();
    const v = j && j.current && j.current.temperature_2m;
    return typeof v === 'number' ? round(v, 1) : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function attachExtTemp(id) {
  fetchTempExt().then((t) => {
    if (t == null || !S) return;
    const e = S.events.find((x) => x.id === id);
    if (e && e.tempExt == null) {
      e.tempExt = t;
      save();
      render();
    }
  });
}

/* ------------------------------ Actions ------------------------------ */
function addOpen() {
  if (locked) return;
  if (stockNow() <= 0 && !confirm('Le stock est à 0. Ouvrir un sac quand même ?')) return;
  const ev = {
    id: uid(), type: 'open', ts: Date.now(),
    brand: lastBrand(), price: currentBagPrice(),
    tempExt: null, tempInt: null, note: ''
  };
  S.events.push(ev);
  save();
  locked = true;
  setTimeout(() => { locked = false; render(); }, 2000);
  if (navigator.vibrate) navigator.vibrate(30);
  render();
  const n = bags().find((b) => b.ev.id === ev.id).n;
  toast(`Sac n°${n} ouvert · reste ${stockNow()}`, [
    { label: 'Annuler', fn: () => { removeEvent(ev.id); toast('Appui annulé'); } },
    { label: 'Détails', fn: () => editSheet(ev.id) }
  ], 7000);
  attachExtTemp(ev.id);
}

function removeEvent(id) {
  S.events = S.events.filter((e) => e.id !== id);
  save();
  locked = false;
  render();
}

function undoLast() {
  const cand = opens().filter((e) => !e.noDeduct);
  const last = cand[cand.length - 1];
  if (!last) { toast('Aucun appui à annuler.'); return; }
  const n = bags().find((b) => b.ev.id === last.id).n;
  if (!confirm(`Annuler le sac n°${n} ouvert le ${fmtDT(last.ts)} ?`)) return;
  removeEvent(last.id);
  toast(`Sac n°${n} annulé · stock : ${stockNow()}`);
}

/* ------------------------------- Rendu ------------------------------- */
function render() {
  document.body.classList.toggle('onboarding', !S);
  const v = $('#view');
  if (!S) { v.innerHTML = renderSetup(); return; }
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const views = { home: renderHome, history: renderHistory, stats: renderStats, settings: renderSettings };
  v.innerHTML = (views[tab] || renderHome)();
}

function renderSetup() {
  return `
    <h1>Bienvenue 🔥</h1>
    <p class="muted">Quelques infos pour démarrer. Tout est modifiable ensuite et reste enregistré sur ce téléphone.</p>
    <form data-form="setup" class="card">
      <label>Sacs en stock (non ouverts)
        <input type="number" name="stock" inputmode="numeric" min="0" step="1" value="85" required>
      </label>
      <label>Sac en cours : ouvert le
        <input type="datetime-local" name="ts" value="${toLocalInput(Date.now())}" required>
      </label>
      <div class="two">
        <label>Prix d'une palette (€)
          <input type="number" name="palettePrice" inputmode="decimal" step="any" min="0" placeholder="ex. 340">
        </label>
        <label>Sacs par palette
          <input type="number" name="bpp" inputmode="numeric" step="1" min="1" placeholder="ex. 65">
        </label>
      </div>
      <p class="hint">Sert à calculer le prix par sac et le coût. Optionnel : tu pourras le renseigner plus tard dans Réglages.</p>
      <label>Marque / lot (optionnel)
        <input name="brand" autocomplete="off" placeholder="ex. DINplus">
      </label>
      <button class="primary">Commencer</button>
    </form>`;
}

function renderHome() {
  const st = computeStats();
  const stock = st.stock;
  const cur = st.cur;
  const days = st.remaining != null ? Math.round(st.remaining / DAY) : null;

  let curHtml;
  if (cur) {
    let progress = '';
    if (st.avg) {
      const el = st.now - cur.start;
      const pct = Math.min(100, (el / st.avg) * 100);
      const over = el > st.avg;
      progress = `
        <div class="progress ${over ? 'over' : ''}"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="small muted">${over ? `Plus long que la moyenne (${fmtDur(st.avg)})` : `${Math.round(pct)} % de la durée moyenne (${fmtDur(st.avg)})`}</div>`;
    } else {
      progress = `<div class="small muted">La durée moyenne apparaîtra dès le 2ᵉ sac.</div>`;
    }
    curHtml = `
      <div class="row">
        <div>
          <div class="kpi-label">Sac n°${cur.n} en cours</div>
          <div class="big" data-since="${cur.start}">${fmtDur(st.now - cur.start)}</div>
        </div>
        <div class="right small muted">ouvert<br>${esc(fmtDT(cur.start))}</div>
      </div>${progress}`;
  } else {
    curHtml = `<div class="muted">Aucun sac ouvert pour l'instant.</div>`;
  }

  return `
    <section class="hero">
      <div class="stock-label">Stock restant</div>
      <div class="stock-num ${stock <= 0 ? 'warn' : ''}">${stock}</div>
      <div class="stock-unit">${Math.abs(stock) > 1 ? 'sacs' : 'sac'} non ouvert${Math.abs(stock) > 1 ? 's' : ''}</div>
      ${st.endDate ? `<span class="chip">Fin estimée : ${esc(fmtDate(st.endDate))} · ≈ ${days} j</span>` : ''}
    </section>
    <section class="card current">${curHtml}</section>
    <button class="bigbtn" data-act="open" ${locked ? 'disabled' : ''} aria-label="Ouvrir un nouveau sac">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      Nouveau sac
    </button>
    <div class="actions">
      <button data-act="undo">↩︎ Annuler le dernier</button>
      <button data-act="delivery">＋ Livraison</button>
      <button data-act="adjust">⚖︎ Ajuster</button>
    </div>`;
}

function renderHistory() {
  const st = computeStats();
  const map = new Map(st.bl.map((b) => [b.ev.id, b]));
  const evs = [...S.events].sort((a, b) => b.ts - a.ts);
  if (!evs.length) return `<h1>Historique</h1><p class="muted">Rien pour l'instant.</p>`;

  const items = evs.map((e) => {
    if (e.type === 'open') {
      const b = map.get(e.id);
      let sub;
      let cmp = '';
      if (b.end != null) {
        const d = b.end - b.start;
        sub = `Durée ${fmtDur(d)}`;
        if (st.avg && st.done.length > 1) {
          const p = Math.round(((d - st.avg) / st.avg) * 100);
          if (Math.abs(p) >= 1) cmp = ` · <span class="${p > 0 ? 'tag-up' : 'tag-down'}">${p > 0 ? '▲ +' : '▼ '}${p} %</span>`;
        }
      } else {
        sub = `En cours · ${fmtDur(st.now - b.start)}`;
      }
      const price = bagPrice(e);
      const temps = [e.tempExt != null ? `ext ${fmtTemp(e.tempExt)}` : '', e.tempInt != null ? `int ${fmtTemp(e.tempInt)}` : ''].filter(Boolean).join(' · ');
      return `<button class="item" data-edit="${e.id}">
        <div class="badge">n°${b.n}</div>
        <div class="main"><div class="t1">${esc(fmtDT(e.ts))}</div><div class="t2">${sub}${cmp}${e.brand ? ' · ' + esc(e.brand) : ''}</div></div>
        <div class="side">${price != null ? esc(fmtEur(price)) : ''}${temps ? `<br>${esc(temps)}` : ''}</div>
      </button>`;
    }
    if (e.type === 'delivery') {
      return `<button class="item" data-edit="${e.id}">
        <div class="badge deliv">＋${e.bags}</div>
        <div class="main"><div class="t1">Livraison · ${esc(fmtDT(e.ts))}</div><div class="t2">${e.bags} sacs${e.total != null ? ' · ' + esc(fmtEur(e.total)) : ''}${e.pricePerBag != null ? ' (' + esc(fmtEur(e.pricePerBag)) + '/sac)' : ''}</div></div>
      </button>`;
    }
    return `<button class="item" data-edit="${e.id}">
      <div class="badge adj">${e.delta > 0 ? '+' : ''}${e.delta}</div>
      <div class="main"><div class="t1">Ajustement de stock · ${esc(fmtDT(e.ts))}</div><div class="t2">${esc(e.note || 'Correction manuelle')}</div></div>
    </button>`;
  }).join('');

  return `<h1>Historique</h1><p class="muted small">Touche une ligne pour corriger la date, le prix, les températures… ou la supprimer.</p><div class="list">${items}</div>`;
}

/* --------------------------- Graphiques SVG --------------------------- */
function niceScale(maxVal) {
  if (!(maxVal > 0)) return { max: 1, step: 0.5 };
  const raw = maxVal / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  return { max: Math.ceil(maxVal / step) * step, step };
}

function svgBars(items, { avg = null, fmt = (v) => fmtNum(v, 1), label = 'Graphique' } = {}) {
  if (!items.length) return '<p class="muted small">Pas encore de données.</p>';
  const W = 340, H = 180, L = 30, R = 8, T = 16, B = 26;
  const n = items.length;
  const { max, step } = niceScale(Math.max(...items.map((i) => i.v), avg || 0));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const bw = (W - L - R) / n;
  const gap = Math.min(6, bw * 0.25);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(label)}">`;
  for (let t = 0; t <= max + 1e-9; t += step) {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-width="1"/>`;
    s += `<text x="${L - 4}" y="${y(t) + 3}" text-anchor="end">${fmt(t)}</text>`;
  }
  const every = Math.ceil(n / 10);
  items.forEach((it, i) => {
    const x = L + i * bw + gap / 2;
    const w = Math.max(2, bw - gap);
    const h = Math.max(0, y(0) - y(it.v));
    s += `<rect x="${x.toFixed(1)}" y="${y(it.v).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${it.dim ? 'var(--accent-soft)' : 'var(--accent)'}"/>`;
    if (n <= 10 && it.v > 0) s += `<text class="val" x="${(x + w / 2).toFixed(1)}" y="${(y(it.v) - 3).toFixed(1)}" text-anchor="middle">${fmt(it.v)}</text>`;
    if (i % every === 0 || i === n - 1) s += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(it.l)}</text>`;
  });
  if (avg) {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(avg)}" y2="${y(avg)}" stroke="var(--ink-2)" stroke-width="1.2" stroke-dasharray="4 4"/>`;
    s += `<text x="${W - R}" y="${y(avg) - 4}" text-anchor="end">moy. ${fmt(avg)}</text>`;
  }
  return s + '</svg>';
}

function stockSeries() {
  const evs = [...S.events].sort((a, b) => a.ts - b.ts);
  let s = Number(S.settings.initialStock) || 0;
  const t0 = evs.length ? evs[0].ts : Date.now();
  const pts = [{ t: t0, s }];
  for (const e of evs) {
    if (e.type === 'delivery') s += Number(e.bags) || 0;
    else if (e.type === 'adjust') s += Number(e.delta) || 0;
    else if (e.type === 'open' && !e.noDeduct) s -= 1;
    else continue;
    pts.push({ t: e.ts, s });
  }
  return pts;
}

function svgStock(st) {
  const pts = stockSeries();
  const now = Date.now();
  const last = pts[pts.length - 1];
  const t0 = pts[0].t;
  const proj = st.endDate && last.s > 0 ? st.endDate : null;
  const tEnd = Math.max(now, proj || 0, t0 + HOUR);
  const W = 340, H = 180, L = 30, R = 10, T = 16, B = 26;
  const maxS = Math.max(...pts.map((p) => p.s), 1);
  const { max, step } = niceScale(maxS);
  const x = (t) => L + ((t - t0) / (tEnd - t0)) * (W - L - R);
  const y = (v) => T + (H - T - B) * (1 - Math.max(v, 0) / max);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Évolution du stock dans le temps">`;
  for (let t = 0; t <= max + 1e-9; t += step) {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/>`;
    s += `<text x="${L - 4}" y="${y(t) + 3}" text-anchor="end">${fmtNum(t, 0)}</text>`;
  }
  let d = `M ${x(pts[0].t).toFixed(1)} ${y(pts[0].s).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` H ${x(pts[i].t).toFixed(1)} V ${y(pts[i].s).toFixed(1)}`;
  d += ` H ${x(now).toFixed(1)}`;
  s += `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/>`;
  if (proj) {
    s += `<line x1="${x(now).toFixed(1)}" y1="${y(last.s).toFixed(1)}" x2="${x(proj).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="var(--ink-2)" stroke-width="1.4" stroke-dasharray="4 4"/>`;
    s += `<text x="${x(proj).toFixed(1)}" y="${H - 8}" text-anchor="end">${esc(fmtShort(proj))} (estim.)</text>`;
  }
  s += `<text x="${L}" y="${H - 8}" text-anchor="start">${esc(fmtShort(t0))}</text>`;
  return s + '</svg>';
}

function weekStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function periodItems(st) {
  const starts = st.bl.map((b) => b.start);
  const out = [];
  if (period === 'week') {
    const ws = weekStart(Date.now());
    for (let i = 7; i >= 0; i--) {
      const a = new Date(ws);
      a.setDate(a.getDate() - i * 7);
      const b = new Date(a);
      b.setDate(b.getDate() + 7);
      out.push({ v: starts.filter((t) => t >= a.getTime() && t < b.getTime()).length, l: fmtShort(a.getTime()), dim: i === 0 });
    }
  } else {
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const a = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const b = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      out.push({
        v: starts.filter((t) => t >= a.getTime() && t < b.getTime()).length,
        l: a.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', ''),
        dim: i === 0
      });
    }
  }
  return out;
}

function renderStats() {
  const st = computeStats();
  if (!st.bl.length) return `<h1>Stats</h1><p class="muted">Pas encore de données.</p>`;

  const unitH = st.avg != null && st.avg < 2 * DAY;
  const div = unitH ? HOUR : DAY;
  const uLabel = unitH ? 'h' : 'j';
  const last20 = st.done.slice(-20);
  const durItems = last20.map((b) => ({ v: (b.end - b.start) / div, l: String(b.n) }));
  const dFmt = (v) => fmtNum(v, unitH ? 0 : 1);

  const card = (label, val, sub) => `<div class="card"><div class="kpi-label">${label}</div><div class="kpi">${val}</div><div class="kpi-sub">${sub || ''}</div></div>`;

  let costHtml = '';
  if (st.totalCost != null) {
    costHtml = `
      <h3>Budget</h3>
      <div class="grid2">
        ${card('Coût consommé', esc(fmtEur(st.totalCost)), `depuis le ${esc(fmtShort(st.since))}`)}
        ${card('Prix moyen / sac', esc(fmtEur(st.avgPrice)), st.unitNow != null ? `dernier prix : ${esc(fmtEur(st.unitNow))}` : '')}
        ${card('Coût / mois', st.costMonth != null ? esc(fmtEur(st.costMonth)) : '—', 'estimé au rythme actuel')}
        ${card('Valeur du stock', st.stockValue != null ? esc(fmtEur(st.stockValue)) : '—', `${Math.max(0, st.stock)} sacs restants`)}
      </div>`;
  } else {
    costHtml = `<h3>Budget</h3><div class="card"><p class="muted small" style="margin:0">Renseigne le prix d'une palette et le nombre de sacs dans Réglages pour voir les coûts.</p></div>`;
  }

  return `
    <h1>Statistiques</h1>
    <div class="grid2">
      ${card('Durée moyenne', st.avg != null ? esc(fmtDur(st.avg)) : '—', st.avg != null ? `min ${esc(fmtDur(st.min))} · max ${esc(fmtDur(st.max))}` : 'dès le 2ᵉ sac')}
      ${card('Total consommé', `${st.bl.length} <small>sacs</small>`, `depuis le ${esc(fmtShort(st.since))}`)}
      ${card('Rythme', st.perWeek != null ? `${fmtNum(st.perWeek, 1)} <small>/ sem.</small>` : '—', st.perMonth != null ? `≈ ${fmtNum(st.perMonth, 1)} sacs / mois` : '')}
      ${card('7 / 30 derniers jours', `${st.w7} <small>/</small> ${st.w30}`, 'sacs ouverts')}
    </div>
    <div class="card" style="margin-top:12px">
      <div class="kpi-label">Fin du stock estimée</div>
      <div class="kpi">${st.endDate ? esc(fmtDate(st.endDate, true)) : '—'}</div>
      <div class="kpi-sub">${st.endDate ? `dans ≈ ${Math.round(st.remaining / DAY)} jours, avec ${Math.max(0, st.stock)} sacs en réserve + le sac en cours` : 'Disponible dès que 2 sacs ont été utilisés.'}</div>
    </div>
    ${costHtml}
    <h3>Durée de chaque sac (${uLabel})</h3>
    <div class="card">${svgBars(durItems, { avg: st.avg != null ? st.avg / div : null, fmt: dFmt, label: 'Durée de chaque sac' })}${st.done.length > 20 ? '<p class="small muted" style="margin:6px 0 0">20 derniers sacs terminés</p>' : ''}</div>
    <h3>Évolution du stock</h3>
    <div class="card">${svgStock(st)}</div>
    <h3>Sacs ouverts par ${period === 'week' ? 'semaine' : 'mois'}</h3>
    <div class="card">
      <div class="seg" role="tablist"><button data-period="week" class="${period === 'week' ? 'on' : ''}">Semaines</button><button data-period="month" class="${period === 'month' ? 'on' : ''}">Mois</button></div>
      ${svgBars(periodItems(st), { fmt: (v) => fmtNum(v, 0), label: 'Sacs ouverts par période' })}
    </div>`;
}

function renderSettings() {
  const s = S.settings;
  const per = defaultBagPrice();
  const theme = s.theme || 'auto';
  return `
    <h1>Réglages</h1>
    <form data-form="settings" class="card">
      <div class="two">
        <label>Prix d'une palette (€)
          <input type="number" name="palettePrice" step="any" min="0" inputmode="decimal" value="${s.palettePrice ?? ''}">
        </label>
        <label>Sacs par palette
          <input type="number" name="bpp" step="1" min="1" inputmode="numeric" value="${s.bagsPerPalette ?? ''}">
        </label>
      </div>
      <p class="hint">${per != null ? `Soit ${esc(fmtEur(per))} par sac.` : 'Le prix par sac sera calculé automatiquement.'}</p>
      <label>Marque / lot par défaut
        <input name="brand" value="${esc(s.brand || '')}" autocomplete="off">
      </label>
      <label>Thème
        <select name="theme">
          <option value="auto" ${theme === 'auto' ? 'selected' : ''}>Automatique (suit le téléphone)</option>
          <option value="light" ${theme === 'light' ? 'selected' : ''}>Clair</option>
          <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Sombre</option>
        </select>
      </label>
      <div class="two">
        <label>Latitude (météo)
          <input type="number" name="lat" step="any" value="${s.lat}">
        </label>
        <label>Longitude (météo)
          <input type="number" name="lon" step="any" value="${s.lon}">
        </label>
      </div>
      <p class="hint">La température extérieure est récupérée automatiquement (Open-Meteo) à chaque nouveau sac. La température intérieure se saisit à la main dans le détail d'un sac.</p>
      <button class="primary">Enregistrer</button>
    </form>

    <h3>Sauvegarde</h3>
    <div class="stack">
      <button class="btn-sec" data-act="export-csv">Exporter en CSV (Excel)</button>
      <button class="btn-sec" data-act="export-json">Sauvegarde complète (JSON)</button>
      <button class="btn-sec" data-act="import-json">Restaurer une sauvegarde</button>
      ${deferredInstall ? '<button class="btn-sec" data-act="install">Installer l\'appli sur l\'écran d\'accueil</button>' : ''}
    </div>
    <p class="hint" style="margin-top:10px">Les données sont stockées uniquement sur ce téléphone. Pense à faire une sauvegarde de temps en temps.</p>

    <h3>Zone sensible</h3>
    <button class="danger-full" data-act="reset">Tout effacer et recommencer</button>`;
}

/* ------------------------------ Feuilles ------------------------------ */
function openSheet(title, body) {
  removeSheet();
  const el = document.createElement('div');
  el.className = 'sheet-wrap';
  el.innerHTML = `<div class="sheet-bg" data-act="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div><h2>${esc(title)}</h2>${body}</div>`;
  document.body.appendChild(el);
  document.body.classList.add('noscroll');
  if (!(history.state && history.state.sheet)) history.pushState({ sheet: 1 }, '');
}

function removeSheet() {
  const el = $('.sheet-wrap');
  if (el) el.remove();
  document.body.classList.remove('noscroll');
}

function closeSheet() {
  removeSheet();
  if (history.state && history.state.sheet) {
    ignorePop = true;
    history.back();
  }
}

window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop = false; return; }
  removeSheet();
});

function editSheet(id) {
  const e = S.events.find((x) => x.id === id);
  if (!e) return;
  const del = `<button type="button" class="danger" data-act="delete" data-id="${id}">Supprimer</button>`;
  const dt = `<label>Date et heure<input type="datetime-local" name="ts" value="${toLocalInput(e.ts)}" required></label>`;
  const note = `<label>Note<input name="note" value="${esc(e.note || '')}" autocomplete="off"></label>`;

  if (e.type === 'open') {
    const b = bags().find((x) => x.ev.id === id);
    openSheet(`Sac n°${b ? b.n : ''}`, `
      <form data-form="edit" data-id="${id}">
        ${dt}
        <div class="two">
          <label>Marque / lot<input name="brand" value="${esc(e.brand || '')}" autocomplete="off"></label>
          <label>Prix du sac (€)<input type="number" name="price" step="any" min="0" inputmode="decimal" value="${e.price ?? ''}"></label>
        </div>
        <div class="two">
          <label>Temp. extérieure (°C)<input type="number" name="tempExt" step="any" value="${e.tempExt ?? ''}"></label>
          <label>Temp. intérieure (°C)<input type="number" name="tempInt" step="any" value="${e.tempInt ?? ''}"></label>
        </div>
        ${note}
        <div class="btns">${del}<button class="primary">Enregistrer</button></div>
      </form>`);
  } else if (e.type === 'delivery') {
    openSheet('Livraison', `
      <form data-form="edit" data-id="${id}">
        ${dt}
        <div class="two">
          <label>Nombre de sacs<input type="number" name="bags" step="1" min="1" inputmode="numeric" value="${e.bags}" required></label>
          <label>Montant payé (€)<input type="number" name="total" step="any" min="0" inputmode="decimal" value="${e.total ?? ''}"></label>
        </div>
        ${note}
        <div class="btns">${del}<button class="primary">Enregistrer</button></div>
      </form>`);
  } else {
    openSheet('Ajustement de stock', `
      <form data-form="edit" data-id="${id}">
        ${dt}
        <label>Variation (± sacs)<input type="number" name="delta" step="1" inputmode="numeric" value="${e.delta}" required></label>
        ${note}
        <div class="btns">${del}<button class="primary">Enregistrer</button></div>
      </form>`);
  }
}

function deliverySheet() {
  const s = S.settings;
  openSheet('Nouvelle livraison', `
    <form data-form="delivery">
      <label>Date et heure<input type="datetime-local" name="ts" value="${toLocalInput(Date.now())}" required></label>
      <div class="two">
        <label>Nombre de sacs<input type="number" name="bags" step="1" min="1" inputmode="numeric" value="${s.bagsPerPalette ?? ''}" required></label>
        <label>Montant payé (€)<input type="number" name="total" step="any" min="0" inputmode="decimal" value="${s.palettePrice ?? ''}"></label>
      </div>
      <p class="hint">Le prix par sac est calculé automatiquement et appliqué aux prochains sacs ouverts.</p>
      <button class="primary">Ajouter au stock</button>
    </form>`);
}

function adjustSheet() {
  openSheet('Ajuster le stock', `
    <form data-form="adjust">
      <label>Nombre réel de sacs non ouverts<input type="number" name="real" step="1" inputmode="numeric" value="${stockNow()}" required></label>
      <p class="hint">Corrige le compteur si ça ne colle plus avec la réalité (l'écart est gardé dans l'historique).</p>
      <button class="primary">Enregistrer</button>
    </form>`);
}

/* ------------------------------ Formulaires ------------------------------ */
const forms = {
  setup(f) {
    const d = new FormData(f);
    const ts = fromInput(d.get('ts')) || Date.now();
    const brand = String(d.get('brand') || '').trim();
    S = {
      v: 1,
      settings: {
        initialStock: Math.max(0, Math.round(num(d.get('stock')) ?? 0)),
        palettePrice: num(d.get('palettePrice')),
        bagsPerPalette: num(d.get('bpp')),
        brand, lat: 50.39, lon: 2.86, theme: 'auto'
      },
      events: []
    };
    const ev = { id: uid(), type: 'open', ts, noDeduct: true, brand, price: defaultBagPrice(), tempExt: null, tempInt: null, note: '' };
    S.events.push(ev);
    save();
    applyTheme();
    render();
    if (Math.abs(Date.now() - ts) < 6 * HOUR) attachExtTemp(ev.id);
    toast('C\'est parti ! Appuie sur « Nouveau sac » à chaque sac ouvert.');
  },

  settings(f) {
    const d = new FormData(f);
    const s = S.settings;
    s.palettePrice = num(d.get('palettePrice'));
    s.bagsPerPalette = num(d.get('bpp'));
    s.brand = String(d.get('brand') || '').trim();
    s.theme = d.get('theme') || 'auto';
    s.lat = num(d.get('lat')) ?? s.lat;
    s.lon = num(d.get('lon')) ?? s.lon;
    save();
    applyTheme();
    render();
    toast('Réglages enregistrés');
  },

  edit(f) {
    const e = S.events.find((x) => x.id === f.dataset.id);
    if (!e) return;
    const d = new FormData(f);
    e.ts = fromInput(d.get('ts')) || e.ts;
    e.note = String(d.get('note') || '').trim();
    if (e.type === 'open') {
      e.brand = String(d.get('brand') || '').trim();
      e.price = round(num(d.get('price')), 4);
      e.tempExt = num(d.get('tempExt'));
      e.tempInt = num(d.get('tempInt'));
    } else if (e.type === 'delivery') {
      e.bags = Math.max(1, Math.round(num(d.get('bags')) ?? 1));
      e.total = num(d.get('total'));
      e.pricePerBag = e.total != null ? round(e.total / e.bags, 4) : null;
    } else {
      e.delta = Math.round(num(d.get('delta')) ?? 0);
    }
    save();
    closeSheet();
    render();
    toast('Modifications enregistrées');
  },

  delivery(f) {
    const d = new FormData(f);
    const bagsN = Math.max(1, Math.round(num(d.get('bags')) ?? 1));
    const total = num(d.get('total'));
    S.events.push({
      id: uid(), type: 'delivery', ts: fromInput(d.get('ts')) || Date.now(),
      bags: bagsN, total, pricePerBag: total != null ? round(total / bagsN, 4) : null, note: ''
    });
    save();
    closeSheet();
    render();
    toast(`+${bagsN} sacs · stock : ${stockNow()}`);
  },

  adjust(f) {
    const d = new FormData(f);
    const real = Math.round(num(d.get('real')) ?? stockNow());
    const delta = real - stockNow();
    if (delta === 0) { closeSheet(); return; }
    S.events.push({ id: uid(), type: 'adjust', ts: Date.now(), delta, note: 'Correction manuelle' });
    save();
    closeSheet();
    render();
    toast(`Stock ajusté à ${real}`);
  }
};

document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  if (forms[f.dataset.form]) forms[f.dataset.form](f);
});

/* ------------------------------ Export / import ------------------------------ */
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const dec = (v) => (v == null ? '' : String(v).replace('.', ','));
const ymdhm = (ts) => toLocalInput(ts).replace('T', ' ');

function exportCSV() {
  const head = ['type', 'numero_sac', 'debut', 'fin', 'duree_heures', 'prix_sac_eur', 'marque', 'temp_ext_c', 'temp_int_c', 'nb_sacs', 'montant_livraison_eur', 'note'];
  const map = new Map(bags().map((b) => [b.ev.id, b]));
  const rows = [...S.events].sort((a, b) => a.ts - b.ts).map((e) => {
    if (e.type === 'open') {
      const b = map.get(e.id);
      return ['sac', b.n, ymdhm(e.ts), b.end ? ymdhm(b.end) : '', b.end ? dec(round((b.end - b.start) / HOUR, 2)) : '', dec(bagPrice(e)), e.brand || '', dec(e.tempExt), dec(e.tempInt), '', '', e.note || ''];
    }
    if (e.type === 'delivery') return ['livraison', '', ymdhm(e.ts), '', '', '', '', '', '', e.bags, dec(e.total), e.note || ''];
    return ['ajustement', '', ymdhm(e.ts), '', '', '', '', '', '', e.delta, '', e.note || ''];
  });
  const csv = '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
  download(`pellets-${ymd(Date.now())}.csv`, csv, 'text/csv;charset=utf-8');
  toast('Fichier CSV exporté');
}

function exportJSON() {
  download(`pellets-sauvegarde-${ymd(Date.now())}.json`, JSON.stringify(S, null, 2), 'application/json');
  toast('Sauvegarde exportée');
}

$('#importFile').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(String(r.result));
      if (!d || !Array.isArray(d.events) || !d.settings) throw new Error('format');
      if (!confirm(`Remplacer les données actuelles par cette sauvegarde (${d.events.length} événements) ?`)) return;
      S = d;
      save();
      applyTheme();
      render();
      toast('Sauvegarde restaurée');
    } catch (err) {
      toast('Fichier invalide : sauvegarde non restaurée.');
    }
  };
  r.readAsText(file);
});

/* ------------------------------ Toast ------------------------------ */
function toast(msg, actions = [], ms = 4500) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${actions.map((a, i) => `<button data-toast="${i}">${esc(a.label)}</button>`).join('')}`;
  t._actions = actions;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ------------------------------ Clics ------------------------------ */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-tab],[data-edit],[data-toast],[data-period]');
  if (!el) return;

  if (el.dataset.toast != null) {
    const t = $('#toast');
    const a = t._actions && t._actions[Number(el.dataset.toast)];
    t.classList.remove('show');
    if (a) a.fn();
    return;
  }
  if (el.dataset.tab) { tab = el.dataset.tab; render(); window.scrollTo(0, 0); return; }
  if (el.dataset.period) { period = el.dataset.period; render(); return; }
  if (el.dataset.edit) { editSheet(el.dataset.edit); return; }

  switch (el.dataset.act) {
    case 'open': addOpen(); break;
    case 'undo': undoLast(); break;
    case 'delivery': deliverySheet(); break;
    case 'adjust': adjustSheet(); break;
    case 'close-sheet': closeSheet(); break;
    case 'delete': {
      const id = el.dataset.id;
      if (confirm('Supprimer cette entrée ? Le stock sera recalculé.')) {
        S.events = S.events.filter((x) => x.id !== id);
        save();
        closeSheet();
        render();
        toast('Entrée supprimée');
      }
      break;
    }
    case 'export-csv': exportCSV(); break;
    case 'export-json': exportJSON(); break;
    case 'import-json': $('#importFile').click(); break;
    case 'install':
      if (deferredInstall) {
        deferredInstall.prompt();
        deferredInstall.userChoice.finally(() => { deferredInstall = null; render(); });
      }
      break;
    case 'reset':
      if (confirm('Effacer TOUTES les données de ce téléphone ?') && confirm('Dernière confirmation : cette action est définitive.')) {
        localStorage.removeItem(KEY);
        S = null;
        tab = 'home';
        render();
      }
      break;
  }
});

/* ------------------------------ Thème & cycle de vie ------------------------------ */
function applyTheme() {
  const t = (S && S.settings.theme) || 'auto';
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#14110f' : '#faf7f2');
}

function tick() {
  document.querySelectorAll('[data-since]').forEach((el) => {
    el.textContent = fmtDur(Date.now() - Number(el.dataset.since));
  });
}
setInterval(tick, 30000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S && !$('.sheet-wrap')) render();
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (S && tab === 'settings') render();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

applyTheme();
render();
