'use strict';
/* TOLANI CYBER X TRADING BOT: public Binance data, paper trading only. */
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TFS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const FEE = 0.001, START_BAL = 1000;
const REST = ['https://api.binance.com', 'https://data-api.binance.vision'];
const WSH = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];

/* ---------- indicators (pure functions, tested separately) ---------- */
function ema(v, p) {
  const o = Array(v.length).fill(null), k = 2 / (p + 1);
  const s = v.findIndex(x => x != null);
  if (s < 0 || v.length - s < p) return o;
  let sum = 0; for (let i = s; i < s + p; i++) sum += v[i];
  let e = sum / p; o[s + p - 1] = e;
  for (let i = s + p; i < v.length; i++) { e = v[i] * k + e * (1 - k); o[i] = e; }
  return o;
}
function rsi(c, p = 14) {
  const o = Array(c.length).fill(null); if (c.length <= p) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p; o[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}
function macd(c) {
  const a = ema(c, 12), b = ema(c, 26);
  const line = c.map((_, i) => a[i] != null && b[i] != null ? a[i] - b[i] : null);
  const sig = ema(line, 9);
  return { line, sig, hist: line.map((x, i) => x != null && sig[i] != null ? x - sig[i] : null) };
}
function bollinger(c, p = 20, m = 2) {
  const up = Array(c.length).fill(null), mid = [...up], lo = [...up];
  for (let i = p - 1; i < c.length; i++) {
    let s = 0; for (let j = i - p + 1; j <= i; j++) s += c[j];
    const mean = s / p; let v = 0; for (let j = i - p + 1; j <= i; j++) v += (c[j] - mean) ** 2;
    const sd = Math.sqrt(v / p); mid[i] = mean; up[i] = mean + m * sd; lo[i] = mean - m * sd;
  }
  return { up, mid, lo };
}
function atr(cs, p = 14) {
  const o = Array(cs.length).fill(null); if (cs.length <= p) return o;
  const tr = cs.map((x, i) => i === 0 ? x.high - x.low :
    Math.max(x.high - x.low, Math.abs(x.high - cs[i - 1].close), Math.abs(x.low - cs[i - 1].close)));
  let a = 0; for (let i = 1; i <= p; i++) a += tr[i]; a /= p; o[p] = a;
  for (let i = p + 1; i < cs.length; i++) { a = (a * (p - 1) + tr[i]) / p; o[i] = a; }
  return o;
}
function computeAll(cs) {
  const c = cs.map(x => x.close);
  return { e9: ema(c, 9), e21: ema(c, 21), e50: ema(c, 50), rsi: rsi(c), macd: macd(c), bb: bollinger(c), atr: atr(cs) };
}

/* ---------- analysis engine: score from -6 (bearish) to +6 (bullish) ---------- */
function analyze(cs, ind, n = cs.length - 1) {
  if (n < 60) return null;
  const px = cs[n].close, e9 = ind.e9[n], e21 = ind.e21[n], e50 = ind.e50[n];
  const r = ind.rsi[n], h = ind.macd.hist[n], hp = ind.macd.hist[n - 1];
  const bu = ind.bb.up[n], bl = ind.bb.lo[n], a = ind.atr[n];
  if ([e9, e21, e50, r, h, hp, bu, bl, a].some(x => x == null || !isFinite(x))) return null;
  let score = 0; const why = [];
  if (e9 > e21 && e21 > e50) { score += 2; why.push(['up', 'EMA 9 > EMA 21 > EMA 50: short, medium and long averages are stacked upward (+2).']); }
  else if (e9 < e21 && e21 < e50) { score -= 2; why.push(['down', 'EMA 9 < EMA 21 < EMA 50: averages are stacked downward (-2).']); }
  else if (e9 > e21) { score += 1; why.push(['up', 'EMA 9 is above EMA 21 but the full stack is not aligned (+1).']); }
  else { score -= 1; why.push(['down', 'EMA 9 is below EMA 21 but the full stack is not aligned (-1).']); }
  if (px > e50) { score += 1; why.push(['up', 'Price is above EMA 50 (+1).']); } else { score -= 1; why.push(['down', 'Price is below EMA 50 (-1).']); }
  if (r < 30) { score += 1; why.push(['up', `RSI ${r.toFixed(1)} is oversold, a bounce is possible (+1).`]); }
  else if (r > 70) { score -= 1; why.push(['down', `RSI ${r.toFixed(1)} is overbought, a pullback is possible (-1).`]); }
  else why.push(['flat', `RSI ${r.toFixed(1)} is neutral (0).`]);
  if (h > 0 && h > hp) { score += 1; why.push(['up', 'MACD histogram is positive and rising (+1).']); }
  else if (h < 0 && h < hp) { score -= 1; why.push(['down', 'MACD histogram is negative and falling (-1).']); }
  else why.push(['flat', 'MACD momentum is mixed or fading (0).']);
  if (px < bl) { score += 1; why.push(['up', 'Price is below the lower Bollinger Band, stretched to the downside (+1).']); }
  else if (px > bu) { score -= 1; why.push(['down', 'Price is above the upper Bollinger Band, stretched to the upside (-1).']); }
  else why.push(['flat', 'Price is inside the Bollinger Bands (0).']);
  const signal = score >= 3 ? 'BUY' : score <= -3 ? 'SELL' : 'HOLD';
  const trend = e21 > e50 && px > e50 ? 'Bullish trend' : e21 < e50 && px < e50 ? 'Bearish trend' : 'Sideways or mixed';
  const dir = score < 0 ? -1 : 1; // direction the levels assume (short bias when score is negative)
  return {
    signal, score, trend, why, entry: px,
    sl: px - dir * 1.5 * a, tp: px + dir * 3 * a,
    confidence: signal === 'HOLD' ? Math.round((1 - Math.abs(score) / 3) * 50) : Math.round(Math.min(95, 40 + (Math.abs(score) - 3) * 18))
  };
}


/* ---------- backtester: long-only, same rules as the live signal ----------
   A signal is read at a candle's close; the order fills at the NEXT candle's open.
   Stop-loss is checked before take-profit inside a candle (the pessimistic choice). */
function backtest(cs, ind, startBal = 1000, fee = 0.001) {
  let cash = startBal, pos = null, pending = null, peak = startBal, maxDD = 0;
  const trades = [], eq = [];
  const exit = (i, px) => {
    const proceeds = pos.qty * px * (1 - fee), pnl = proceeds - pos.cost;
    trades.push({ entryTime: pos.time, exitTime: cs[i].time, pnl, ret: pnl / pos.cost * 100 });
    cash = proceeds; pos = null;
  };
  for (let i = 60; i < cs.length; i++) {
    const c = cs[i];
    if (pending === 'exit' && pos) exit(i, c.open);
    else if (pending && pending.sl !== undefined && !pos) {
      pos = { qty: cash * (1 - fee) / c.open, cost: cash, time: c.time, sl: pending.sl, tp: pending.tp }; cash = 0;
    }
    pending = null;
    if (pos) {
      if (c.low <= pos.sl) exit(i, Math.min(c.open, pos.sl));
      else if (c.high >= pos.tp) exit(i, Math.max(c.open, pos.tp));
    }
    if (pos && i === cs.length - 1) exit(i, c.close);
    const equity = cash + (pos ? pos.qty * c.close * (1 - fee) : 0);
    peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak * 100);
    eq.push({ time: c.time, value: equity });
    if (i < cs.length - 1) {
      const a = analyze(cs, ind, i);
      if (a && !pos && a.signal === 'BUY') pending = { sl: a.sl, tp: a.tp };
      else if (a && pos && a.signal === 'SELL') pending = 'exit';
    }
  }
  const wins = trades.filter(t => t.pnl > 0), gw = wins.reduce((a, t) => a + t.pnl, 0), gl = trades.filter(t => t.pnl <= 0).reduce((a, t) => a - t.pnl, 0);
  return { trades, eq, final: cash, ret: (cash / startBal - 1) * 100, maxDD,
    winRate: trades.length ? wins.length / trades.length * 100 : null, pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null),
    hold: (cs[cs.length - 1].close / cs[60].close - 1) * 100, from: cs[60].time, to: cs[cs.length - 1].time };
}

/* ---------- summary of a multi-coin comparison ---------- */
function compareSummary(rows) {
  const n = rows.length || 1;
  return { n: rows.length, beats: rows.filter(r => r.ret > r.hold).length, thin: rows.filter(r => r.trades < 20).length,
    avgRet: rows.reduce((a, r) => a + r.ret, 0) / n, avgHold: rows.reduce((a, r) => a + r.hold, 0) / n };
}

/* ---------- data validation ---------- */
function parseKlineRow(r) {
  return { time: Math.floor(+r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] };
}
function validCandle(c) {
  return [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 && c.low > 0 && c.volume >= 0 &&
    c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close);
}

if (typeof module !== 'undefined') module.exports = { ema, rsi, macd, bollinger, atr, computeAll, analyze, backtest, compareSummary, parseKlineRow, validCandle };

/* ---------- application (browser only) ---------- */
function init() {
  const $ = id => document.getElementById(id);
  const S = { sym: 'BTCUSDT', tf: '15m', candles: [], ind: null, prices: {}, t24: {}, loadId: 0 };
  const fmt = (n, d) => Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d ?? (n < 10 ? 4 : 2), maximumFractionDigits: d ?? (n < 10 ? 4 : 2) }) : '-';
  const cls = n => n >= 0 ? 'up' : 'down';

  /* status + overlay */
  const setStatus = (t, k) => { $('status').className = 'status ' + (k || ''); $('status').querySelector('span').textContent = t; };
  const showOverlay = (msg, retry) => { $('overlay').hidden = false; $('overlayMsg').textContent = msg; $('retry').hidden = !retry; };
  const hideOverlay = () => { $('overlay').hidden = true; };

  /* charts */
  if (typeof LightweightCharts === 'undefined') { showOverlay('The chart library did not load. Check your internet connection and refresh the page.', false); setStatus('Chart library missing', 'err'); return; }
  const base = { autoSize: true, layout: { background: { color: '#0a050a' }, textColor: '#9a8294' },
    grid: { vertLines: { color: '#1a0f17' }, horzLines: { color: '#1a0f17' } },
    rightPriceScale: { borderColor: '#2a1521' }, timeScale: { borderColor: '#2a1521', timeVisible: true, secondsVisible: false } };
  const chart = LightweightCharts.createChart($('chart'), base);
  const rsiC = LightweightCharts.createChart($('rsi'), base);
  const macdC = LightweightCharts.createChart($('macd'), base);
  const L = (ch, color, w) => ch.addLineSeries({ color, lineWidth: w || 1, priceLineVisible: false, lastValueVisible: false });
  const candle = chart.addCandlestickSeries({ upColor: '#19d38a', downColor: '#ff4d4d', borderUpColor: '#19d38a', borderDownColor: '#ff4d4d', wickUpColor: '#19d38a', wickDownColor: '#ff4d4d' });
  const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  const SER = { e9: L(chart, '#f0c14b', 1.5), e21: L(chart, '#4aa3ff', 1.5), e50: L(chart, '#c26bff', 1.5),
    bu: L(chart, '#6b6b72'), bm: L(chart, '#4a4a50'), bl: L(chart, '#6b6b72'),
    rsi: L(rsiC, '#d4af37', 1.5), mh: macdC.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }),
    ml: L(macdC, '#4aa3ff', 1.5), ms: L(macdC, '#f0c14b', 1.5) };
  SER.rsi.createPriceLine({ price: 70, color: '#ff4d4d', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
  SER.rsi.createPriceLine({ price: 30, color: '#19d38a', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' });
  rsiC.priceScale('right').applyOptions({ autoScale: false, scaleMargins: { top: 0.05, bottom: 0.05 } });
  let syncing = false;
  [chart, rsiC, macdC].forEach(src => src.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (syncing || !r) return; syncing = true;
    [chart, rsiC, macdC].forEach(t => { if (t !== src) t.timeScale().setVisibleLogicalRange(r); });
    syncing = false;
  }));
  const GROUPS = { ema9: [SER.e9], ema21: [SER.e21], ema50: [SER.e50], bb: [SER.bu, SER.bm, SER.bl], vol: [vol] };
  document.querySelectorAll('#toggles input').forEach(cb => cb.addEventListener('change', () =>
    GROUPS[cb.dataset.k].forEach(s => s.applyOptions({ visible: cb.checked }))));

  /* indicator series updates */
  const pt = (cs, arr, i) => arr[i] != null && isFinite(arr[i]) ? { time: cs[i].time, value: arr[i] } : null;
  function seriesMap(ind) {
    return [[SER.e9, ind.e9], [SER.e21, ind.e21], [SER.e50, ind.e50], [SER.bu, ind.bb.up], [SER.bm, ind.bb.mid], [SER.bl, ind.bb.lo],
      [SER.rsi, ind.rsi], [SER.ml, ind.macd.line], [SER.ms, ind.macd.sig]];
  }
  const histPt = (cs, h, i) => h[i] == null ? null : { time: cs[i].time, value: h[i], color: h[i] >= 0 ? '#19d38a99' : '#ff4d4d99' };
  const volPt = c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? '#19d38a55' : '#ff4d4d55' });
  function drawAll() {
    const cs = S.candles, ind = S.ind;
    candle.setData(cs.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    vol.setData(cs.map(volPt));
    seriesMap(ind).forEach(([s, a]) => s.setData(cs.map((_, i) => pt(cs, a, i)).filter(Boolean)));
    SER.mh.setData(cs.map((_, i) => histPt(cs, ind.macd.hist, i)).filter(Boolean));
  }
  function drawLast() {
    const cs = S.candles, i = cs.length - 1, c = cs[i], ind = S.ind;
    candle.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
    vol.update(volPt(c));
    seriesMap(ind).forEach(([s, a]) => { const p = pt(cs, a, i); if (p) s.update(p); });
    const hp = histPt(cs, ind.macd.hist, i); if (hp) SER.mh.update(hp);
  }

  /* network */
  async function getJson(path) {
    let last;
    for (const b of REST) {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
      try {
        const res = await fetch(b + path, { signal: ctl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) { last = e; } finally { clearTimeout(t); }
    }
    throw last;
  }

  /* websocket: exactly one connection, always closed before a new one opens */
  let ws = null, wsId = 0, wsTry = 0, wsTimer = null;
  function closeWs() {
    clearTimeout(wsTimer); wsId++;
    if (ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; try { ws.close(); } catch (e) { } ws = null; }
  }
  function openWs() {
    closeWs();
    const my = wsId, streams = [...SYMS.map(s => s.toLowerCase() + '@ticker'), `${S.sym.toLowerCase()}@kline_${S.tf}`, `${S.sym.toLowerCase()}@aggTrade`, `${S.sym.toLowerCase()}@depth10@100ms`].join('/');
    setStatus('Connecting', '');
    try { ws = new WebSocket(`${WSH[wsTry % 2]}/stream?streams=${streams}`); } catch (e) { setStatus('WebSocket unavailable', 'err'); return; }
    ws.onopen = () => { if (my === wsId) { wsTry = 0; setStatus('Live', 'live'); logEv('Connected to Binance stream: ' + S.sym + ' ' + S.tf, 'muted'); } };
    ws.onmessage = ev => { if (my !== wsId) return; try { onMsg(JSON.parse(ev.data)); } catch (e) { /* ignore malformed message */ } };
    ws.onerror = () => { };
    ws.onclose = () => {
      if (my !== wsId) return;
      wsTry++; setStatus('Disconnected, retrying', 'err');
      wsTimer = setTimeout(() => { if (my === wsId) openWs(); }, Math.min(15000, 1000 * wsTry));
    };
  }
  function onMsg(m) {
    const d = m.data; if (!d) return;
    if (m.stream && m.stream.includes('@depth')) { S.book = d; scheduleBook(); return; }
    if (d.e === 'aggTrade') { onTrade(d); return; }
    if (d.e === '24hrTicker') {
      const last = +d.c; if (!(last > 0)) return;
      S.prices[d.s] = last;
      S.t24[d.s] = { last, high: +d.h, low: +d.l, pct: +d.P, vol: +d.v, qvol: +d.q };
      renderTiles(); if (d.s === S.sym) renderStats(); autoTick(d.s); renderTrading();
    } else if (d.e === 'kline' && d.s === S.sym && d.k.i === S.tf) {
      const k = d.k, c = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
      if (!validCandle(c) || !S.candles.length) return;
      const lastC = S.candles[S.candles.length - 1];
      if (c.time === lastC.time) S.candles[S.candles.length - 1] = c;
      else if (c.time > lastC.time) S.candles.push(c); else return;
      S.ind = computeAll(S.candles); drawLast(); renderSignal();
    }
  }

  /* load history for the current symbol and timeframe */
  async function load() {
    const id = ++S.loadId;
    closeWs(); S.book = null; parts = []; flow = []; showOverlay(`Loading ${S.sym} ${S.tf} candles from Binance`, false); setStatus('Loading', '');
    try {
      const rows = await getJson(`/api/v3/klines?symbol=${S.sym}&interval=${S.tf}&limit=500`);
      if (id !== S.loadId) return;
      if (!Array.isArray(rows)) throw new Error('Unexpected response from Binance');
      const cs = rows.map(parseKlineRow).filter(validCandle);
      if (cs.length < 60) throw new Error(`Only ${cs.length} valid candles were returned, so indicators cannot be calculated`);
      S.candles = cs; S.ind = computeAll(cs); drawAll();
      chart.timeScale().fitContent(); hideOverlay(); renderSignal(); renderStats(); openWs();
    } catch (e) {
      if (id !== S.loadId) return;
      showOverlay(`Could not load market data: ${e.message || e}. Check your internet connection, VPN or firewall, then press Retry.`, true);
      setStatus('Data error', 'err');
    }
  }
  async function loadTickers() {
    try {
      const arr = await getJson('/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(SYMS)));
      arr.forEach(d => { const last = +d.lastPrice; if (last > 0) { S.prices[d.symbol] = last;
        S.t24[d.symbol] = { last, high: +d.highPrice, low: +d.lowPrice, pct: +d.priceChangePercent, vol: +d.volume, qvol: +d.quoteVolume }; } });
      renderTiles(); renderStats(); renderTrading();
    } catch (e) { /* WebSocket tickers will fill these in */ }
  }

  /* UI rendering */
  const tapeHTML = SYMS.map(s => `<span class="tp" data-s="${s}">${s.replace('USDT', '/USDT')}<b>...</b><em></em></span>`).join('');
  $('tape').innerHTML = `<div class="track"><span class="half">${tapeHTML}</span><span class="half">${tapeHTML}</span></div>`;
  const big = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : (n / 1e6).toFixed(1) + 'M';
  function renderTiles() {
    SYMS.forEach(s => { const t = S.t24[s]; if (!t) return;
      document.querySelectorAll(`.tp[data-s="${s}"]`).forEach(el => { el.querySelector('b').textContent = fmt(t.last);
        const e = el.querySelector('em'); e.textContent = (t.pct >= 0 ? '+' : '') + t.pct.toFixed(2) + '%'; e.className = cls(t.pct); }); });
    $('watch').innerHTML = '<tr><th>Pair</th><th>Last</th><th>24h</th><th>Vol USDT</th></tr>' + SYMS.map(s => { const t = S.t24[s];
      return `<tr data-s="${s}" class="${s === S.sym ? 'sel' : ''}"><td>${s.replace('USDT', '/USDT')}</td><td>${t ? fmt(t.last) : '...'}</td><td class="${t ? cls(t.pct) : ''}">${t ? (t.pct >= 0 ? '+' : '') + t.pct.toFixed(2) + '%' : ''}</td><td>${t ? big(t.qvol) : ''}</td></tr>`; }).join('');
  }
  function renderStats() {
    const t = S.t24[S.sym];
    $('stats').innerHTML = t ? `<div class="px ${cls(t.pct)}">${fmt(t.last)}</div>
      <div><span>24h change</span><b class="${cls(t.pct)}">${t.pct >= 0 ? '+' : ''}${t.pct.toFixed(2)}%</b></div>
      <div><span>24h high</span><b>${fmt(t.high)}</b></div><div><span>24h low</span><b>${fmt(t.low)}</b></div>
      <div><span>24h volume (${S.sym.replace('USDT', '')})</span><b>${fmt(t.vol, 2)}</b></div>
      <div><span>24h volume (USDT)</span><b>${fmt(t.qvol, 0)}</b></div>` : '<span class="muted">Loading 24h statistics</span>';
  }
  function renderSignal() {
    const a = analyze(S.candles, S.ind);
    if (!a) { $('sig').textContent = 'HOLD'; $('sig').className = 'sig HOLD'; $('reasons').innerHTML = '<li>Not enough data to calculate a signal yet.</li>'; return; }
    handleSignal(a); $('sig').textContent = a.signal; $('sig').className = 'sig ' + a.signal;
    $('trend').textContent = a.trend; $('confBar').style.width = a.confidence + '%';
    $('confTxt').textContent = `Indicator agreement: ${a.confidence}% (score ${a.score > 0 ? '+' : ''}${a.score} of 6). Not a prediction.`;
    $('levels').innerHTML = `<div><span>Entry estimate</span><b>${fmt(a.entry)}</b></div><div><span>Stop-loss</span><b class="down">${fmt(a.sl)}</b></div><div><span>Take-profit</span><b class="up">${fmt(a.tp)}</b></div>`;
    $('reasons').innerHTML = a.why.map(([k, t]) => `<li class="${k === 'flat' ? 'muted' : k}">${t}</li>`).join('');
  }

  /* paper trading */
  let P;
  try { P = JSON.parse(localStorage.getItem('tolaniPaper')); } catch (e) { P = null; }
  if (!P || !Number.isFinite(P.bal) || !P.pos || !Array.isArray(P.hist)) P = { bal: START_BAL, pos: {}, hist: [], eqh: [] };
  P.eqh = Array.isArray(P.eqh) ? P.eqh : [];
  const save = () => { try { localStorage.setItem('tolaniPaper', JSON.stringify(P)); } catch (e) { } };
  const msg = (t, k) => { $('orderMsg').textContent = t; $('orderMsg').className = 'small ' + (k || 'muted'); };
  function buy(sym, usdt, meta) {
    const px = S.prices[sym];
    if (!(px > 0)) return msg('No live price yet. Wait for the connection.', 'down');
    if (!(usdt >= 1)) return msg('Enter an amount of at least 1 USDT.', 'down');
    if (usdt > P.bal + 1e-9) return msg(`Not enough balance. You have ${fmt(P.bal, 2)} USDT.`, 'down');
    const qty = usdt * (1 - FEE) / px, p = P.pos[sym] || { qty: 0, cost: 0 };
    p.qty += qty; p.cost += usdt; P.pos[sym] = p; if (meta) { p.sl = meta.sl; p.tp = meta.tp; } P.bal -= usdt;
    P.hist.unshift({ t: Date.now(), sym, side: 'BUY', px, qty, pnl: null }); save(); renderTrading();
    logEv(`BUY ${sym} ${qty.toFixed(6)} @ ${fmt(px)} (${meta ? 'auto' : 'manual'})`, 'up');
    msg(`Bought ${qty.toFixed(6)} ${sym.replace('USDT', '')} at ${fmt(px)} (simulated).`, 'up');
  }
  function closePos(sym, why = 'manual') {
    const p = P.pos[sym], px = S.prices[sym];
    if (!p) return msg('You have no open position in ' + sym + '.', 'down');
    if (!(px > 0)) return msg('No live price yet.', 'down');
    const proceeds = p.qty * px * (1 - FEE), pnl = proceeds - p.cost;
    P.bal += proceeds; delete P.pos[sym];
    P.hist.unshift({ t: Date.now(), sym, side: 'SELL', px, qty: p.qty, pnl }); save(); renderTrading();
    logEv(`SELL ${sym} ${p.qty.toFixed(6)} @ ${fmt(px)} (${why}) P&L ${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)} USDT`, pnl >= 0 ? 'up' : 'down');
    msg(`Closed ${sym} at ${fmt(px)}. P&L ${pnl >= 0 ? '+' : ''}${fmt(pnl, 2)} USDT (simulated).`, pnl >= 0 ? 'up' : 'down');
  }
  function renderTrading() {
    let open = 0, unreal = 0;
    const rows = Object.entries(P.pos).map(([s, p]) => { const px = S.prices[s] || 0, v = p.qty * px, u = v * (1 - FEE) - p.cost;
      open += v; unreal += u;
      return `<tr><td>${s.replace('USDT', '')}</td><td>${p.qty.toFixed(5)}</td><td>${fmt(p.cost / p.qty)}</td><td>${fmt(px)}</td><td class="${cls(u)}">${u >= 0 ? '+' : ''}${fmt(u, 2)}</td></tr>`; });
    const eq = P.bal + open, tot = eq - START_BAL;
    $('eqBig').textContent = '$' + fmt(eq, 2); $('eqBig').className = cls(tot); sampleEquity(eq);
    $('acct').innerHTML = `<div><span>Cash (USDT)</span><b>${fmt(P.bal, 2)}</b></div><div><span>Equity (USDT)</span><b>${fmt(eq, 2)}</b></div>
      <div><span>Unrealized P&amp;L</span><b class="${cls(unreal)}">${fmt(unreal, 2)}</b></div><div><span>Total P&amp;L</span><b class="${cls(tot)}">${fmt(tot, 2)}</b></div>${winBoxes()}`;
    $('posTbl').innerHTML = rows.length ? `<tr><th>Coin</th><th>Qty</th><th>Avg</th><th>Now</th><th>P&amp;L</th></tr>${rows.join('')}` : '<tr><td class="empty">No open positions</td></tr>';
    $('histTbl').innerHTML = P.hist.length ? `<tr><th>Time</th><th>Pair</th><th>Side</th><th>Price</th><th>P&amp;L</th></tr>` +
      P.hist.slice(0, 50).map(h => `<tr><td>${new Date(h.t).toLocaleTimeString()}</td><td>${h.sym.replace('USDT', '')}</td><td class="${h.side === 'BUY' ? 'up' : 'down'}">${h.side}</td><td>${fmt(h.px)}</td><td class="${h.pnl == null ? 'muted' : cls(h.pnl)}">${h.pnl == null ? '-' : fmt(h.pnl, 2)}</td></tr>`).join('')
      : '<tr><td class="empty">No trades yet</td></tr>';
  }


  /* ---- execution log, auto paper-trader, order book, trade-bubble flow ---- */
  S.auto = false; S.lastSig = {}; S.book = null;
  let parts = [], flow = [], bookT = null;
  function logEv(txt, k) {
    const el = $('log'), d = document.createElement('div'); d.className = k || '';
    d.textContent = `[${new Date().toLocaleTimeString([], { hour12: false })}] ${txt}`; el.prepend(d);
    while (el.children.length > 120) el.lastChild.remove();
  }
  function winBoxes() {
    const c = P.hist.filter(h => h.side === 'SELL'), w = c.filter(h => h.pnl > 0).length;
    return `<div><span>Win rate</span><b>${c.length ? Math.round(w / c.length * 100) + '%' : 'n/a'}</b></div><div><span>Closed trades</span><b>${c.length}</b></div>`;
  }
  function handleSignal(a) {
    const key = S.sym + S.tf, prev = S.lastSig[key]; S.lastSig[key] = a.signal;
    if (prev === undefined) { logEv(`${S.sym} ${S.tf} signal is ${a.signal} (score ${a.score})`, 'muted'); return; }
    if (prev === a.signal) return;
    logEv(`SIGNAL ${S.sym} ${S.tf}: ${prev} -> ${a.signal} (score ${a.score > 0 ? '+' : ''}${a.score})`, a.signal === 'BUY' ? 'up' : a.signal === 'SELL' ? 'down' : 'muted');
    if (!S.auto) return;
    if (a.signal === 'BUY' && !P.pos[S.sym]) {
      const amt = Math.floor(P.bal * 0.25 * 100) / 100;
      if (amt >= 10) buy(S.sym, amt, { sl: a.sl, tp: a.tp }); else logEv('AUTO skipped: not enough cash (needs 10 USDT)', 'muted');
    } else if (a.signal === 'SELL' && P.pos[S.sym]) closePos(S.sym, 'auto: sell signal');
  }
  function autoTick(sym) {
    const p = P.pos[sym], px = S.prices[sym]; if (!p || p.sl == null || !(px > 0)) return;
    if (px <= p.sl) closePos(sym, 'auto: stop-loss'); else if (px >= p.tp) closePos(sym, 'auto: take-profit');
  }
  $('auto').addEventListener('change', e => { S.auto = e.target.checked; logEv(S.auto ? 'AUTO paper-trading ON (25% of cash per entry, stop-loss and take-profit from the signal)' : 'AUTO paper-trading OFF', 'muted'); });

  function scheduleBook() { if (!bookT) bookT = setTimeout(() => { bookT = null; renderBook(); }, 250); }
  function renderBook() {
    const b = S.book; if (!b || !Array.isArray(b.bids) || !Array.isArray(b.asks)) return;
    const get = a => a.slice(0, 8).map(r => [+r[0], +r[1]]).filter(r => r[0] > 0 && r[1] >= 0);
    const bids = get(b.bids), asks = get(b.asks); if (!bids.length || !asks.length) return;
    const mx = Math.max(...bids.map(r => r[1]), ...asks.map(r => r[1])) || 1;
    const row = (r, k) => `<tr><td class="${k}">${fmt(r[0])}</td><td>${fmt(r[1], 4)}</td><td><div style="height:12px;width:${(r[1] / mx * 100).toFixed(0)}%;margin-left:auto;background:${k === 'up' ? 'rgba(25,211,138,.4)' : 'rgba(255,77,77,.4)'}"></div></td></tr>`;
    $('book').className = '';
    $('book').innerHTML = `<table class="bk">${asks.slice().reverse().map(r => row(r, 'down')).join('')}<tr class="mid"><td colspan="3">${fmt(S.prices[S.sym] || bids[0][0])} <span class="muted">spread ${fmt(asks[0][0] - bids[0][0])}</span></td></tr>${bids.map(r => row(r, 'up')).join('')}</table>`;
  }

  const cv = $('flow'), cx = cv.getContext('2d');
  function sizeCv() { const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1; cv.width = r.width * d; cv.height = r.height * d; cx.setTransform(d, 0, 0, d, 0, 0); }
  if (window.ResizeObserver) new ResizeObserver(sizeCv).observe(cv); else sizeCv();
  function onTrade(d) {
    const p = +d.p, q = +d.q; if (!(p > 0 && q > 0)) return;
    const usd = p * q, sell = d.m === true, w = cv.clientWidth, h = cv.clientHeight;
    flow.push({ t: Date.now(), usd, sell });
    if (parts.length > 300) parts.shift();
    parts.push({ x: Math.random() * w, y: h * (0.15 + 0.75 * Math.random()), r: Math.min(26, 2 + Math.sqrt(usd) / 12), c: sell ? '#ff4d4d' : '#19d38a',
      whale: usd >= (S.sym === 'BTCUSDT' ? 100000 : S.sym === 'ETHUSDT' ? 50000 : 20000), born: performance.now(), vx: (Math.random() - .5) * .3, vy: (Math.random() - .5) * .3 });
  }
  function frame(now) {
    requestAnimationFrame(frame); if (document.hidden) return;
    const w = cv.clientWidth, h = cv.clientHeight; cx.clearRect(0, 0, w, h);
    parts = parts.filter(p => now - p.born < 20000);
    if (!parts.length) { cx.fillStyle = '#9a8294'; cx.font = '12px monospace'; cx.textAlign = 'center'; cx.fillText('Waiting for live trades', w / 2, h / 2); return; }
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; cx.globalAlpha = Math.max(0, 1 - (now - p.born) / 20000); cx.fillStyle = p.c;
      cx.beginPath(); cx.arc(p.x, p.y, p.r, 0, 6.283); cx.fill();
      if (p.whale) { cx.strokeStyle = '#fff'; cx.lineWidth = 1.5; cx.stroke(); }
    }
    cx.globalAlpha = 1;
  }
  requestAnimationFrame(frame);
  setInterval(() => {
    const cut = Date.now() - 60000; flow = flow.filter(f => f.t >= cut);
    const bu = flow.filter(f => !f.sell).reduce((a, f) => a + f.usd, 0), se = flow.reduce((a, f) => a + f.usd, 0) - bu, tot = bu + se;
    $('flowStat').textContent = tot ? `last 60s: ${flow.length} trades, buyers ${(bu / tot * 100).toFixed(0)}% / sellers ${(se / tot * 100).toFixed(0)}% (${big(tot)} USDT)` : '';
  }, 1000);

  /* paper equity curve (area chart) */
  const eqC = LightweightCharts.createChart($('eqChart'), { ...base, rightPriceScale: { visible: false }, timeScale: { visible: false },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } }, crosshair: { horzLine: { visible: false }, vertLine: { visible: false } }, handleScroll: false, handleScale: false });
  const eqSeries = eqC.addAreaSeries({ lineColor: '#19d38a', topColor: 'rgba(25,211,138,.35)', bottomColor: 'rgba(25,211,138,0)', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  eqSeries.setData(P.eqh); eqC.timeScale().fitContent();
  function sampleEquity(v) {
    const now = Math.floor(Date.now() / 1000), l = P.eqh[P.eqh.length - 1];
    if (l && now - l.time < 10) return;
    const p = { time: now, value: +v.toFixed(2) }; P.eqh.push(p); if (P.eqh.length > 600) P.eqh.shift();
    eqSeries.update(p); eqC.timeScale().fitContent(); save();
  }

  /* backtest panel */
  const btChart = LightweightCharts.createChart($('btChart'), { ...base, timeScale: { ...base.timeScale, timeVisible: false } });
  const btLine = btChart.addLineSeries({ color: '#d4af37', lineWidth: 2, priceLineVisible: false });
  $('btRun').addEventListener('click', () => {
    if (S.candles.length < 100 || !S.ind) { $('btOut').innerHTML = '<p class="muted">Wait for the chart to load first.</p>'; return; }
    const r = backtest(S.candles, S.ind, START_BAL, FEE), d = t => new Date(t * 1000).toLocaleDateString();
    const f = (v, s) => v == null ? 'n/a' : (v === Infinity ? 'no losses' : fmt(v, 2) + (s || ''));
    btLine.setData(r.eq); btChart.timeScale().fitContent();
    $('btOut').innerHTML = `<p class="muted small">${S.sym} ${S.tf}: ${d(r.from)} to ${d(r.to)} (${r.eq.length} candles tested)</p>
      <div class="acct"><div><span>Bot return</span><b class="${cls(r.ret)}">${r.ret >= 0 ? '+' : ''}${fmt(r.ret, 2)}%</b></div>
      <div><span>Just holding</span><b class="${cls(r.hold)}">${r.hold >= 0 ? '+' : ''}${fmt(r.hold, 2)}%</b></div>
      <div><span>Trades</span><b>${r.trades.length}</b></div><div><span>Win rate</span><b>${f(r.winRate, '%')}</b></div>
      <div><span>Worst drop</span><b class="down">-${fmt(r.maxDD, 2)}%</b></div><div><span>Profit factor</span><b>${f(r.pf)}</b></div></div>
      <p class="note">${r.trades.length < 20 ? 'Fewer than 20 trades is too few to trust: the result may be luck. ' : ''}Past results do not predict future results. Fees (0.1% per side) are included; real slippage is not.</p>`;
  });

  /* ---- real orders via local server.js (keys never touch the browser) ---- */
  let LV = null;
  async function api(p, body) {
    const r = await fetch(p, { method: body ? 'POST' : 'GET', headers: { 'X-Tolani': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j;
  }
  async function refreshLive() {
    const b = $('liveBadge'), set = (t, k, info) => { b.textContent = t; b.className = 'badge ' + k; $('liveInfo').textContent = info; };
    try {
      LV = await api('/api/status');
      const real = LV.mode === 'live';
      set(real ? 'LIVE: REAL MONEY' : LV.dryRun ? 'TESTNET DRY-RUN' : 'TESTNET', real ? 'live' : '',
        `Limits: ${LV.maxOrder} USDT per order, ${LV.maxDaily} USDT per day (used ${LV.used.toFixed(2)}). ${LV.hasKeys ? '' : 'API keys missing in .env. '}${LV.dryRun ? 'Dry run: orders are checked by Binance but not executed.' : ''}`);
      $('killBtn').textContent = 'Kill switch: ' + (LV.killed ? 'ON (trading stopped)' : 'OFF');
      let bal = null; if (LV.hasKeys) { try { bal = await api('/api/balance'); } catch (e) { $('liveMsg').textContent = e.message; } }
      const coin = S.sym.replace('USDT', '');
      $('liveAcct').innerHTML = `<div><span>USDT free</span><b>${bal ? fmt(bal.USDT, 2) : '-'}</b></div><div><span>${coin} held by bot</span><b>${fmt(LV.pos[S.sym] || 0, 6)}</b></div>`;
    } catch (e) { LV = null; set('OFFLINE', 'off', 'Server not reachable. Run node server.js and open http://127.0.0.1:3000 (not Live Server).'); }
  }
  async function realOrder(side) {
    if (!LV) return $('liveMsg').textContent = 'Server is offline.';
    const usdt = parseFloat($('liveAmt').value), what = side === 'BUY' ? `BUY ${usdt} USDT of ${S.sym}` : `SELL the bot's ${S.sym}`;
    const tag = LV.mode === 'live' ? 'REAL MONEY' : LV.dryRun ? 'testnet dry run' : 'testnet (fake money)';
    if (!confirm(`${tag}\n\n${what}\n\nContinue?`)) return;
    try { const r = await api('/api/order', { symbol: S.sym, side, usdt }); $('liveMsg').textContent = r.message; logEv('REAL ORDER: ' + r.message, side === 'BUY' ? 'up' : 'down'); }
    catch (e) { $('liveMsg').textContent = 'Blocked: ' + e.message; logEv('REAL ORDER REFUSED: ' + e.message, 'down'); }
    refreshLive();
  }
  $('liveBuy').addEventListener('click', () => realOrder('BUY'));
  $('liveSell').addEventListener('click', () => realOrder('SELL'));
  $('killBtn').addEventListener('click', async () => { if (!LV) return; try { await api('/api/kill', { on: !LV.killed }); logEv('Kill switch ' + (!LV.killed ? 'ON' : 'OFF'), 'muted'); } catch (e) { $('liveMsg').textContent = e.message; } refreshLive(); });
  refreshLive(); setInterval(refreshLive, 15000);

  /* compare all coins and timeframes */
  let cmpBusy = false;
  $('btAll').addEventListener('click', async () => {
    if (cmpBusy) return; cmpBusy = true; $('btAll').disabled = true;
    const out = $('btAllOut'), TF4 = ['15m', '1h', '4h', '1d'], rows = []; let i = 0;
    try {
      for (const sym of SYMS) for (const tf of TF4) {
        i++; out.innerHTML = `<p class="muted small">Testing ${sym} ${tf} (${i} of ${SYMS.length * TF4.length})...</p>`;
        try {
          const cs = (await getJson(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=1000`)).map(parseKlineRow).filter(validCandle);
          if (cs.length < 100) throw new Error('too few candles');
          const r = backtest(cs, computeAll(cs), START_BAL, FEE);
          rows.push({ sym, tf, trades: r.trades.length, win: r.winRate, ret: r.ret, hold: r.hold, dd: r.maxDD, days: (r.to - r.from) / 86400 });
        } catch (e) { rows.push({ sym, tf, err: true }); }
      }
      const good = rows.filter(r => !r.err), failed = rows.length - good.length;
      if (!good.length) { out.innerHTML = '<p class="down">Could not download candles from Binance. Check your connection and try again.</p>'; return; }
      const sm = compareSummary(good), p = v => (v >= 0 ? '+' : '') + fmt(v, 1) + '%';
      out.innerHTML = `<table><tr><th>Pair</th><th>TF</th><th>Days</th><th>Trades</th><th>Win</th><th>Bot</th><th>Hold</th><th>Drop</th></tr>` +
        good.map(r => `<tr><td>${r.sym.replace('USDT', '')}</td><td>${r.tf}</td><td>${r.days.toFixed(0)}</td><td class="${r.trades < 20 ? 'muted' : ''}">${r.trades}</td><td>${r.win == null ? '-' : r.win.toFixed(0) + '%'}</td>` +
          `<td class="${r.ret > r.hold ? 'up' : 'down'}">${p(r.ret)}</td><td class="${cls(r.hold)}">${p(r.hold)}</td><td class="down">-${fmt(r.dd, 1)}%</td></tr>`).join('') + '</table>' +
        `<p class="note"><b>Beat holding in ${sm.beats} of ${sm.n} tests.</b> Average bot ${p(sm.avgRet)} vs average holding ${p(sm.avgHold)}. ` +
        `${sm.thin} of ${sm.n} tests had fewer than 20 trades (greyed), which is too few to trust. ` +
        (sm.beats <= sm.n / 2 ? 'The signals did not beat simply holding in most tests, so they are not showing an edge. ' : 'Beating holding in past data is not proof it will in future; check that it holds across coins and timeframes, not one lucky case. ') +
        `Fees (0.1% per side) are included, slippage is not.${failed ? ` ${failed} test(s) failed to download.` : ''}</p>`;
    } finally { cmpBusy = false; $('btAll').disabled = false; }
  });

  /* controls */
  $('tfs').innerHTML = TFS.map(t => `<button data-t="${t}" class="${t === S.tf ? 'active' : ''}">${t}</button>`).join('');
  $('tfs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.dataset.t === S.tf) return;
    S.tf = b.dataset.t; document.querySelectorAll('#tfs button').forEach(x => x.classList.toggle('active', x === b)); load(); });
  $('watch').addEventListener('click', e => { const b = e.target.closest('tr[data-s]'); if (!b || b.dataset.s === S.sym) return;
    S.sym = b.dataset.s; renderTiles(); renderStats(); load(); });
  setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString([], { hour12: false }); }, 1000);
  $('retry').addEventListener('click', load);
  $('buyBtn').addEventListener('click', () => buy(S.sym, parseFloat($('amt').value)));
  $('sellBtn').addEventListener('click', () => closePos(S.sym));
  $('quick').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return;
    $('amt').value = Math.floor(P.bal * (+b.dataset.p / 100) * 100) / 100; });
  $('resetBtn').addEventListener('click', () => { if (confirm('Reset your paper account to 1,000 USDT and clear all trades?')) {
    P = { bal: START_BAL, pos: {}, hist: [], eqh: [] }; eqSeries.setData([]); save(); renderTrading(); msg('Account reset.', 'muted'); } });

  renderTiles(); renderTrading(); loadTickers(); load();
}
if (typeof document !== 'undefined') init();
