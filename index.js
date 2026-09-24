import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// ═══ Axiom Auth State ═══
let refreshToken = process.env.AXIOM_REFRESH_TOKEN || '';
let accessToken = '';
let cfBm = '';
let lastRefresh = 0;
// RH (robinhood-api2) cere cf_clearance (IP-bound) → stocăm cookie-ul RH COMPLET,
// exact cum îl trimite browserul, și-l trimitem verbatim. Hot-swap via /update-cookie {rhCookie}.
let rhCookie = '';

const REFRESH_INTERVAL = 14 * 60 * 1000;

let _authSticky = 0; // 🎯 sticky: ultimul nod pe care auth/refresh a mers → încercat primul (self-learning, ca la axiomFetch)
let _lastRefreshAttempt = 0;
const REFRESH_COOLDOWN_MS = 30000;
async function refreshAccessToken() {
  // ⛔ COOLDOWN: `needsRefresh()` întoarce true la fiecare cerere cât timp accessToken e gol/expirat. Dacă /auth/refresh
  // e throttled (425), FIECARE cerere ar re-încerca refresh-ul → rotim 5 noduri × N cereri → INUNDĂM /auth/refresh →
  // Axiom throttle → 425 permanent (loop auto-provocat). Limităm la 1 încercare / 30s. Datele merg oricum cu refresh-token-ul.
  if (Date.now() - _lastRefreshAttempt < REFRESH_COOLDOWN_MS) return false;
  _lastRefreshAttempt = Date.now();
  // Rotește subdomeniul și pentru auth/refresh: dacă nodul dă 425/404/5xx (Axiom LB / rută mutată), încearcă altul.
  const _authBase = [3, 8, 2, 6, 10];
  const _authNodes = _authSticky ? [_authSticky, ..._authBase.filter(n => n !== _authSticky)] : _authBase;
  for (let ai = 0; ai < _authNodes.length; ai++) {
    try {
      console.log(`[${ts()}] 🔄 Refreshing access token${ai ? ` (api${_authNodes[ai]})` : ''}...`);

      const res = await fetch(`https://api${_authNodes[ai]}.axiom.trade/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cookie': `auth-refresh-token=${refreshToken}`,
          'referer': 'https://axiom.trade/',
          'origin': 'https://axiom.trade',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (res.status === 526) {
        console.log(`[${ts()}] ⏳ Axiom SSL issue — skipping refresh`);
        return false;
      }
      // ⛔ 425/429 „Too Early" = rate-limit GLOBAL al refresh-ului (toate nodurile refuză la fel, NU-i problemă de nod).
      // Rotația ar trimite și mai multe apeluri → și mai mult throttle. OPRIM și așteptăm cooldown-ul (datele merg oricum).
      if (res.status === 425 || res.status === 429) {
        console.log(`[${ts()}] ⚠️ auth api${_authNodes[ai]} ${res.status} (too early / rate-limit) → opresc, aștept cooldown`);
        break;
      }
      // 404 (ruta nu-i pe nod) sau 5xx (eroare de server) = problemă de NOD → rotește la altul care O ARE.
      if (res.status === 404 || (res.status >= 500 && res.status <= 599)) {
        console.log(`[${ts()}] ⚠️ auth api${_authNodes[ai]} ${res.status} → rotate (rută/nod)`);
        continue;
      }

      const setCookies = res.headers.getSetCookie?.() || [];
      const rawSetCookie = res.headers.get('set-cookie') || '';

      let newAccess = '';
      let newRefresh = '';
      let newCfBm = '';

      const allCookies = [...setCookies, ...rawSetCookie.split(',')];

      for (const c of allCookies) {
        const accessMatch = c.match(/auth-access-token=([^;]+)/);
        if (accessMatch) newAccess = accessMatch[1];

        const refreshMatch = c.match(/auth-refresh-token=([^;]+)/);
        if (refreshMatch) newRefresh = refreshMatch[1];

        const cfMatch = c.match(/__cf_bm=([^;]+)/);
        if (cfMatch) newCfBm = cfMatch[1];
      }

      try {
        const body = await res.text();
        if (body.includes('access')) {
          try {
            const data = JSON.parse(body);
            if (data.accessToken) newAccess = data.accessToken;
          } catch (e) {}
        }
      } catch (e) {}

      if (newAccess) {
        accessToken = newAccess;
        if (newRefresh) refreshToken = newRefresh;
        if (newCfBm) cfBm = newCfBm;
        lastRefresh = Date.now();
        _authSticky = _authNodes[ai];                                  // memorează nodul auth care a mers
        console.log(`[${ts()}] ✅ Access token refreshed${ai ? ` (via api${_authNodes[ai]})` : ''}`);
        return true;
      }

      // Fără access + non-tranzitoriu (ex 401 = refresh-token mort) → n-are rost să rotim, oprim.
      console.log(`[${ts()}] ⚠️ Refresh failed. Status: ${res.status}`);
      return false;
    } catch (e) {
      console.log(`[${ts()}] ❌ Refresh error api${_authNodes[ai]}: ${e.message} → rotate`);
      continue;
    }
  }
  return false;
}

function buildCookie() {
  let cookie = `auth-refresh-token=${refreshToken}`;
  if (accessToken) cookie += `; auth-access-token=${accessToken}`;
  if (cfBm) cookie += `; __cf_bm=${cfBm}`;
  return cookie;
}

function needsRefresh() {
  return !accessToken || (Date.now() - lastRefresh > REFRESH_INTERVAL);
}

function ts() {
  return new Date().toISOString().slice(11, 19);
}

// ═══ Axiom Fees ═══
// ═══ Axiom subdomain rotation ═══
// Axiom load-balancează pe api2..api11 — un nod dă uneori 425 „Too Early"/5xx (sau 404 dacă ruta nu-i pe nodul ăla)
// în timp ce alt nod merge (observat: pair-info pe api2 pică, pe api3 merge). Codul vechi hardcoda UN subdomeniu și
// la eșec doar reîmprospăta token-ul pe ACELAȘI nod → 425 rămânea. Acum rotim la alt api-N pe eșec tranzitoriu.
// Plafonat la MAX_AXIOM_TRIES ca să NU bursteze Axiom (max N apeluri/cerere, doar pe eșec — cazul normal = 1 apel).
const AXIOM_NODES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MAX_AXIOM_TRIES = 4;
const _axTransient = s => s === 425 || s === 429 || s === 404 || (s >= 500 && s <= 599);
// 🎯 STICKY (Opțiunea A — self-learning): reține ultimul subdomeniu care A MERS pt fiecare endpoint (`key`) și-l
// încearcă PRIMUL data viitoare → nu re-ghicește la fiecare cerere. Când Axiom mută ruta pe alt nod, prima cerere
// care rotește găsește noul nod și-l memorează → următoarele merg direct pe el (fără apel irosit, fără update manual).
const _stickyNode = {}; // key -> ultimul subdomeniu bun
function axiomHeaders() {
  return {
    'cookie': buildCookie(),
    'referer': 'https://axiom.trade/',
    'origin': 'https://axiom.trade',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'accept': 'application/json'
  };
}
// Întoarce un Response fetch OK, sau { ok:false, status, _allFailed, _last } dacă toate nodurile încercate au picat.
async function axiomFetch(pathAndQuery, { preferred, tag, key }) {
  const first = _stickyNode[key] || preferred;                        // pornește de la ultimul nod bun (sticky), altfel default
  const order = [first, ...AXIOM_NODES.filter(n => n !== first)].slice(0, MAX_AXIOM_TRIES);
  const _ok = (resp, n, rotated) => { if (_stickyNode[key] !== n) { console.log(`[${ts()}] 🎯 ${tag} → api${n} memorat${rotated ? ' (rotit de la api' + first + ')' : ''}`); _stickyNode[key] = n; } return resp; };
  let refreshedOnce = false, last = 'n/a';
  for (let i = 0; i < order.length; i++) {
    const n = order[i];
    const url = `https://api${n}.axiom.trade${pathAndQuery}`;
    let response;
    try { response = await fetch(url, { headers: axiomHeaders() }); }
    catch (e) { last = `api${n} ${e.message}`; continue; }             // eroare de rețea → alt nod
    if (response.ok) return _ok(response, n, i > 0);
    const st = response.status;
    // Auth expirat → refresh O SINGURĂ DATĂ, retry pe ACELAȘI nod (nu-i problemă de nod)
    if ((st === 401 || st === 403) && !refreshedOnce) {
      refreshedOnce = true;
      if (await refreshAccessToken()) {
        try { const r2 = await fetch(url, { headers: axiomHeaders() }); if (r2.ok) return _ok(r2, n, i > 0); last = `api${n} ${r2.status}`; } catch (e) { last = `api${n} ${e.message}`; }
      }
      continue;                                                        // încă prost → rotește
    }
    last = `api${n} ${st}`;
    if (_axTransient(st)) continue;                                    // 425/429/404/5xx = nod prost → rotește
    return response;                                                   // alt cod (ex 400) → întoarce cum e
  }
  return { ok: false, status: 425, _allFailed: true, _last: last };
}

app.get('/fees/:pool', async (req, res) => {
  const pool = req.params.pool;
  if (!pool || pool.length < 30) {
    return res.json({ error: 'invalid pool', totalPairFeesPaid: 0 });
  }
  if (needsRefresh()) await refreshAccessToken();
  try {
    const response = await axiomFetch(`/token-info-v2?pairAddress=${pool}&v=${Date.now()}`, { preferred: 10, tag: `fees ${pool.slice(0, 8)}`, key: 'fees' });
    if (!response.ok) {
      console.log(`[${ts()}] ❌ ${pool.slice(0, 8)} → ${response._last || response.status}`);
      return res.json({ error: `axiom ${response._allFailed ? (response._last || 'all-nodes') : response.status}`, totalPairFeesPaid: 0 });
    }
    const data = await response.json();
    console.log(`[${ts()}] ✅ ${pool.slice(0, 8)} → fees: ${data.totalPairFeesPaid || 0}`);
    res.json(data);
  } catch (e) {
    console.log(`[${ts()}] ❌ ${pool.slice(0, 8)} → ${e.message}`);
    res.json({ error: e.message, totalPairFeesPaid: 0 });
  }
});

// ═══ Axiom Pair Info (real deployer / CTO detection) ═══
// Returns Axiom's full pair-info JSON. The field that matters for CTO detection is
// data.extra.pumpDeployerAddress = the ORIGINAL pump.fun deployer (pump.fun's own
// `creator` gets reassigned on a CTO, so only Axiom keeps the real one).
app.get('/pair-info/:pair', async (req, res) => {
  const pair = req.params.pair;
  if (!pair || pair.length < 30) {
    return res.json({ error: 'invalid pair' });
  }

  if (needsRefresh()) await refreshAccessToken();
  try {
    const response = await axiomFetch(`/pair-info?pairAddress=${pair}&v=${Date.now()}`, { preferred: 6, tag: `pair-info ${pair.slice(0, 8)}`, key: 'pair-info' });
    if (!response.ok) {
      console.log(`[${ts()}] ❌ pair-info ${pair.slice(0, 8)} → ${response._last || response.status}`);
      return res.json({ error: `axiom ${response._allFailed ? (response._last || 'all-nodes') : response.status}` });
    }
    const data = await response.json();
    const dep = data?.extra?.pumpDeployerAddress || null;
    console.log(`[${ts()}] ✅ pair-info ${pair.slice(0, 8)} → deployer ${dep ? dep.slice(0, 8) : 'n/a'}`);
    res.json(data);
  } catch (e) {
    console.log(`[${ts()}] ❌ pair-info ${pair.slice(0, 8)} → ${e.message}`);
    res.json({ error: e.message });
  }
});

// ═══ Axiom Dev Tokens (COMPLETE cross-platform token list for a creator) ═══
// pump.fun's user-created-coins API only returns pump.fun tokens — it MISSES tokens a dev
// launched directly on Raydium / other launchpads. Axiom's dev-tokens-v5 returns ALL of them,
// so a good creator's real track record (winners, fees, ATH) isn't undercounted.
app.get('/dev-tokens/:wallet', async (req, res) => {
  const wallet = req.params.wallet;
  if (!wallet || wallet.length < 30) {
    return res.json({ error: 'invalid wallet', tokens: [] });
  }

  if (needsRefresh()) await refreshAccessToken();
  try {
    const response = await axiomFetch(`/dev-tokens-v5?devAddress=${wallet}&v=${Date.now()}`, { preferred: 7, tag: `dev-tokens ${wallet.slice(0, 8)}`, key: 'dev-tokens' });
    if (!response.ok) {
      console.log(`[${ts()}] ❌ dev-tokens ${wallet.slice(0, 8)} → ${response._last || response.status}`);
      return res.json({ error: `axiom ${response._allFailed ? (response._last || 'all-nodes') : response.status}`, tokens: [] });
    }
    const data = await response.json();
    const arr = Array.isArray(data) ? data : (data.tokens || data.data || []);
    console.log(`[${ts()}] ✅ dev-tokens ${wallet.slice(0, 8)} → ${arr.length} tokens`);
    res.json({ tokens: arr });
  } catch (e) {
    console.log(`[${ts()}] ❌ dev-tokens ${wallet.slice(0, 8)} → ${e.message}`);
    res.json({ error: e.message, tokens: [] });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROBINHOOD CHAIN (EVM) — Axiom servește datele RH pe host SEPARAT de Solana:
//   robinhood-api2.axiom.trade/dev-tokens?devAddress=0x...   (api7 e Solana-only → 500 pe EVM)
// Auth-ul (refresh/access/__cf_bm) e ACELAȘI cont → refolosim buildCookie().
// Toate hosturile Axiom sunt geo-gated (404 de pe IP datacenter regiunea VPS) → merge doar de pe Railway.
// ═══════════════════════════════════════════════════════════════════════════
const RH_AX = 'https://robinhood-api2.axiom.trade';
function rhHeaders() {
  // Trimite cookie-ul RH COMPLET (cu cf_clearance) dacă e setat; altfel fallback la buildCookie().
  return {
    'cookie': rhCookie || buildCookie(),
    'referer': 'https://robinhood.axiom.trade/',
    'origin': 'https://robinhood.axiom.trade',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'accept': 'application/json'
  };
}

// RH dev-tokens — TOATE tokenele lansate de un creator pe Robinhood Chain
app.get('/rh/dev-tokens/:dev', async (req, res) => {
  const dev = req.params.dev;
  if (!dev || !/^0x[0-9a-fA-F]{40}$/.test(dev)) return res.json({ error: 'invalid dev', tokens: [] });
  if (needsRefresh()) await refreshAccessToken();
  const url = `${RH_AX}/dev-tokens?devAddress=${dev}&v=${Date.now()}`;
  try {
    let r = await fetch(url, { headers: rhHeaders() });
    if (!r.ok && (r.status === 401 || r.status === 403 || r.status === 404)) {
      if (await refreshAccessToken()) r = await fetch(url, { headers: rhHeaders() });
    }
    if (!r.ok) { console.log(`[${ts()}] ❌ rh/dev-tokens ${dev.slice(0, 8)} → ${r.status}`); return res.json({ error: `axiom ${r.status}`, tokens: [] }); }
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data.tokens || data.data || []);
    console.log(`[${ts()}] ✅ rh/dev-tokens ${dev.slice(0, 8)} → ${arr.length}`);
    res.json({ tokens: arr });
  } catch (e) { console.log(`[${ts()}] ❌ rh/dev-tokens ${dev.slice(0, 8)} → ${e.message}`); res.json({ error: e.message, tokens: [] }); }
});

// ═══ GMGN (dev_created_tokens: is_open=migrat + total_fee + token_ath_mc, FIABIL, 1 call) ═══
// GMGN e Cloudflare-gated ca Axiom → merge doar de pe IP curat (Railway). Cookie opțional (gmgnCookie).
let gmgnCookie = '';
function gmgnHeaders() {
  const h = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'accept': 'application/json', 'referer': 'https://gmgn.ai/', 'origin': 'https://gmgn.ai' };
  if (gmgnCookie) h['cookie'] = gmgnCookie;
  return h;
}
app.get('/gmgn', async (req, res) => {
  if ((req.headers['x-api-key'] || '') !== (process.env.API_KEY || 'sniper2025')) return res.status(401).json({ error: 'unauthorized' });
  const path = req.query.path; if (!path) return res.json({ error: 'need ?path=' });
  const url = `https://gmgn.ai/${String(path).replace(/^\//, '')}`;
  try {
    const r = await fetch(url, { headers: gmgnHeaders() });
    const body = await r.text();
    res.json({ status: r.status, url, body: body.slice(0, 80000) });
  } catch (e) { res.json({ error: e.message }); }
});

// RH passthrough generic (guarded) — descoperă token-info / fees RH fără alt redeploy.
//   GET /rh/ax?path=token-info?pairAddress=0x...      header  x-api-key: sniper2025
app.get('/rh/ax', async (req, res) => {
  if ((req.headers['x-api-key'] || '') !== (process.env.API_KEY || 'sniper2025')) return res.status(401).json({ error: 'unauthorized' });
  const path = req.query.path; if (!path) return res.json({ error: 'need ?path=' });
  if (needsRefresh()) await refreshAccessToken();
  const url = `${RH_AX}/${String(path).replace(/^\//, '')}`;
  try {
    let r = await fetch(url, { headers: rhHeaders() });
    if (!r.ok && (r.status === 401 || r.status === 403)) { if (await refreshAccessToken()) r = await fetch(url, { headers: rhHeaders() }); }
    const body = await r.text();
    res.json({ status: r.status, url, body: body.slice(0, 20000) });
  } catch (e) { res.json({ error: e.message }); }
});

// ═══ Manual Cookie Update ═══
app.post('/update-cookie', express.json(), (req, res) => {
  const key = req.headers['x-api-key'] || '';
  if (key !== (process.env.API_KEY || 'sniper2025')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.body.gmgnCookie !== undefined) {
    gmgnCookie = req.body.gmgnCookie || '';
    console.log(`[${ts()}] 🔑 GMGN cookie updated (len ${gmgnCookie.length})`);
    return res.json({ ok: true, gmgnCookie: gmgnCookie.length });
  }
  if (req.body.rhCookie) {
    // cookie RH COMPLET (cu cf_clearance) trimis verbatim la robinhood-api2
    rhCookie = req.body.rhCookie;
    // extrage și tokenele pt refresh Solana (bonus)
    const rt = req.body.rhCookie.match(/auth-refresh-token=([^;]+)/);
    const at = req.body.rhCookie.match(/auth-access-token=([^;]+)/);
    const cf = req.body.rhCookie.match(/__cf_bm=([^;]+)/);
    if (rt) refreshToken = rt[1];
    if (at) { accessToken = at[1]; lastRefresh = Date.now(); }
    if (cf) cfBm = cf[1];
    console.log(`[${ts()}] 🔑 RH cookie updated (len ${rhCookie.length})`);
    res.json({ ok: true, rhCookie: rhCookie.length });
  } else if (req.body.refreshToken) {
    refreshToken = req.body.refreshToken;
    accessToken = '';
    lastRefresh = 0;
    console.log(`[${ts()}] 🔑 Refresh token updated`);
    res.json({ ok: true });
  } else if (req.body.cookie) {
    const rt = req.body.cookie.match(/auth-refresh-token=([^;]+)/);
    const at = req.body.cookie.match(/auth-access-token=([^;]+)/);
    const cf = req.body.cookie.match(/__cf_bm=([^;]+)/);
    if (rt) refreshToken = rt[1];
    if (at) { accessToken = at[1]; lastRefresh = Date.now(); }
    if (cf) cfBm = cf[1];
    console.log(`[${ts()}] 🔑 Cookie updated`);
    res.json({ ok: true });
  } else {
    res.json({ error: 'provide refreshToken or cookie' });
  }
});

// ═══ Status ═══
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'axiom-fees-proxy',
    endpoints: ['/fees/:pool', '/pair-info/:pair', '/dev-tokens/:wallet', '/rh/dev-tokens/:dev', '/rh/ax?path='],
    hasRefreshToken: refreshToken.length > 0,
    hasAccessToken: accessToken.length > 0,
    hasRhCookie: rhCookie.length > 0,
    lastRefresh: lastRefresh > 0 ? `${Math.floor((Date.now() - lastRefresh) / 1000)}s ago` : 'never',
    needsRefresh: needsRefresh()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Axiom Fees Proxy running on port ${PORT}`);
  console.log(`🔑 Refresh token: ${refreshToken ? 'SET' : 'NOT SET'}`);

  if (refreshToken) {
    refreshAccessToken();
  }
});
