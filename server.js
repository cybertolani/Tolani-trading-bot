'use strict';
/* TOLANI CYBER X: local trading server. Holds your API keys, enforces limits, serves the 3 page files.
   Start with:  node server.js   then open  http://127.0.0.1:3000   (not Live Server). */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) { /* no .env yet */ }
const E = process.env, MODE = (E.MODE || 'testnet').toLowerCase(), DRY = (E.DRY_RUN || 'true').toLowerCase() !== 'false';
const KEY = E.BINANCE_API_KEY || '', SEC = E.BINANCE_API_SECRET || '';
const MAX_ORDER = +E.MAX_ORDER_USDT || 10, MAX_DAY = +E.MAX_DAILY_USDT || 30, PORT = +E.PORT || 3000;
if (MODE !== 'live' && MODE !== 'testnet') { console.error('MODE must be testnet or live'); process.exit(1); }
if (MODE === 'live' && E.I_UNDERSTAND_REAL_MONEY !== 'yes') { console.error('MODE=live needs I_UNDERSTAND_REAL_MONEY=yes in .env. Stopping.'); process.exit(1); }
const BASE = MODE === 'live' ? 'https://api.binance.com' : (E.BINANCE_BASE || 'https://testnet.binance.vision'); // override only works on testnet (used for testing)
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const SF = E.STATE_FILE || path.join(__dirname, 'state.json');
let st = { day: '', notional: 0, killed: false, pos: {} };
try { st = Object.assign(st, JSON.parse(fs.readFileSync(SF, 'utf8'))); } catch (e) { /* fresh state */ }
const save = () => fs.writeFileSync(SF, JSON.stringify(st, null, 1));
const rollDay = () => { const d = new Date().toISOString().slice(0, 10); if (st.day !== d) { st.day = d; st.notional = 0; save(); } };

const sign = q => crypto.createHmac('sha256', SEC).update(q).digest('hex');
async function bn(method, p, params = {}, signed = false) {
  let q = new URLSearchParams(params).toString();
  if (signed) { if (!KEY || !SEC) throw new Error('API keys missing: fill in BINANCE_API_KEY and BINANCE_API_SECRET in .env'); q += (q ? '&' : '') + `recvWindow=5000&timestamp=${Date.now()}`; q += `&signature=${sign(q)}`; }
  const r = await fetch(BASE + p + (q ? '?' + q : ''), { method, headers: KEY ? { 'X-MBX-APIKEY': KEY } : {}, signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Binance ${r.status}: ${j.msg || 'error'} (${j.code || ''})`);
  return j;
}
function floorStep(q, step) { const d = (step.split('.')[1] || '').replace(/0+$/, '').length, f = 10 ** d; return (Math.floor(q * f + 1e-9) / f).toFixed(d); }
async function symInfo(sym) {
  const s = (await bn('GET', '/api/v3/exchangeInfo', { symbol: sym })).symbols[0], f = s.filters;
  const n = f.find(x => x.filterType === 'NOTIONAL' || x.filterType === 'MIN_NOTIONAL');
  return { base: s.baseAsset, step: f.find(x => x.filterType === 'LOT_SIZE').stepSize, minN: n ? +n.minNotional : 0 };
}
async function balance() {
  const a = await bn('GET', '/api/v3/account', {}, true), g = x => +(a.balances.find(b => b.asset === x) || { free: 0 }).free;
  return { USDT: g('USDT'), BTC: g('BTC'), ETH: g('ETH'), SOL: g('SOL') };
}
async function order({ symbol, side, usdt }) {
  rollDay();
  if (st.killed) throw new Error('Kill switch is ON. Trading is stopped.');
  if (!SYMS.includes(symbol)) throw new Error('Unsupported symbol');
  if (side !== 'BUY' && side !== 'SELL') throw new Error('Side must be BUY or SELL');
  const f = await symInfo(symbol), params = { symbol, side, type: 'MARKET', newOrderRespType: 'FULL' };
  if (side === 'BUY') {
    usdt = +usdt;
    if (!(usdt > 0)) throw new Error('Enter a valid USDT amount');
    if (usdt > MAX_ORDER) throw new Error(`${usdt} USDT is above your per-order limit of ${MAX_ORDER} USDT (MAX_ORDER_USDT in .env)`);
    if (usdt < f.minN) throw new Error(`Binance minimum order for ${symbol} is ${f.minN} USDT`);
    if (st.notional + usdt > MAX_DAY) throw new Error(`This would pass your daily limit of ${MAX_DAY} USDT (used ${st.notional.toFixed(2)})`);
    params.quoteOrderQty = usdt.toFixed(2);
  } else {
    const have = st.pos[symbol] || 0;
    if (!(have > 0)) throw new Error(`The bot holds no ${f.base} from its own buys, so there is nothing to sell. It never sells coins you bought yourself.`);
    const free = (await balance())[f.base] || 0, q = floorStep(Math.min(have, free), f.step);
    if (!(+q > 0)) throw new Error('Quantity is below the exchange minimum step');
    params.quantity = q;
  }
  const res = await bn('POST', DRY ? '/api/v3/order/test' : '/api/v3/order', params, true);
  if (DRY) return { dryRun: true, message: `Dry run accepted by Binance: ${side} ${symbol}. Nothing was executed.` };
  const exec = +res.executedQty || 0, quote = +res.cummulativeQuoteQty || 0;
  const net = (res.fills || []).reduce((a, x) => a + +x.qty - (x.commissionAsset === f.base ? +x.commission : 0), 0);
  if (side === 'BUY') { st.pos[symbol] = (st.pos[symbol] || 0) + net; st.notional += quote; }
  else { st.pos[symbol] = Math.max(0, (st.pos[symbol] || 0) - exec); if (st.pos[symbol] < 1e-12) delete st.pos[symbol]; }
  save();
  return { dryRun: false, status: res.status, executedQty: exec, quote, avgPrice: exec ? quote / exec : 0, message: `${side} ${symbol} ${res.status}: ${exec} for ${quote.toFixed(2)} USDT` };
}

const FILES = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/script.js': 'script.js' };
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
http.createServer(async (req, res) => {
  const send = (c, o, t = 'application/json') => { res.writeHead(c, { 'Content-Type': t, 'Cache-Control': 'no-store' }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return send(403, { error: 'Bad host' });
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/api/')) {
    const f = FILES[u.pathname]; if (!f) return send(404, 'Not found', 'text/plain');
    return send(200, fs.readFileSync(path.join(__dirname, f)), MIME[path.extname(f)]);
  }
  if (req.headers['x-tolani'] !== '1' || (req.headers.origin && req.headers.origin !== 'http://' + host)) return send(403, { error: 'Request blocked' });
  try {
    if (req.method === 'GET' && u.pathname === '/api/status') { rollDay(); return send(200, { mode: MODE, dryRun: DRY, hasKeys: !!(KEY && SEC), maxOrder: MAX_ORDER, maxDaily: MAX_DAY, used: st.notional, killed: st.killed, pos: st.pos }); }
    if (req.method === 'GET' && u.pathname === '/api/balance') return send(200, await balance());
    if (req.method === 'POST') {
      const body = await new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 2000) { req.destroy(); no(new Error('Too large')); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(new Error('Bad JSON')); } }); });
      if (u.pathname === '/api/order') return send(200, await order(body));
      if (u.pathname === '/api/kill') { st.killed = !!body.on; save(); return send(200, { killed: st.killed }); }
    }
    send(404, { error: 'Unknown endpoint' });
  } catch (e) { send(400, { error: e.message || String(e) }); }
}).listen(PORT, '127.0.0.1', () => console.log(`TOLANI CYBER X server: http://127.0.0.1:${PORT}  mode=${MODE}  dryRun=${DRY}  maxOrder=${MAX_ORDER}  maxDaily=${MAX_DAY}  keys=${KEY && SEC ? 'yes' : 'NO'}`));
