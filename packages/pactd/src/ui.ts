// Minimal self-contained status UI served at / by pactd. No build step, no deps:
// a single HTML page whose JS calls the existing JSON endpoints (same origin).
// Security contract:
//  - The bearer token is NEVER written into the page. The operator pastes it
//    into the lock screen once per tab session (sessionStorage only); a 401
//    clears it and asks again.
//  - Relay/operator-derived strings are assigned through textContent / DOM
//    properties only — never interpolated into an HTML string — so a hostile
//    bond id or pubkey cannot become markup. Handlers are closures bound to
//    the row object; no data-attribute identity round-trips.
//  - A CSP meta tag caps exfil channels (default-src 'none').

export function renderUI(
  // Deprecated: the token argument is deliberately unused — the page must not
  // carry it. Kept in the signature for the existing call site.
  _token: string | undefined,
  publicPort?: string,
  relayPublicPort?: string,
  // Embedded only behind an authenticating proxy (PACT_UI_EMBED_TOKEN); the
  // token is otherwise operator-supplied (sessionStorage / #token= fragment).
  embedToken = false,
): string {
  const tokenLiteral = embedToken ? JSON.stringify(_token ?? '').replace(/</g, '\u003c') : '""';
  const publicPortJson = JSON.stringify(publicPort ?? '');
  const relayPublicPortJson = JSON.stringify(relayPublicPort ?? '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" />
<title>Pact</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; background:#0b0b0f; color:#e7e7ea; }
  .wrap { max-width:760px; margin:0 auto; padding:28px 18px 60px; }
  header { display:flex; align-items:center; gap:12px; margin-bottom:8px; }
  header h1 { font-size:22px; margin:0; letter-spacing:.5px; }
  .badge { font-size:12px; color:#9a9aa3; }
  .card { background:#15151c; border:1px solid #23232e; border-radius:14px; padding:18px; margin-top:16px; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#9a9aa3; margin:0 0 12px; }
  .kv { display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-bottom:1px solid #1d1d26; }
  .kv:last-child { border-bottom:0; }
  .kv .k { color:#9a9aa3; } .kv .v { font-family:ui-monospace,Menlo,monospace; font-size:13px; word-break:break-all; text-align:right; }
  .ok { color:#5ad17f; } .warn { color:#f7931a; } .muted { color:#6b6b76; }
  button { background:#f7931a; color:#0b0b0f; border:0; border-radius:9px; padding:9px 14px; font-weight:600; cursor:pointer; }
  button.secondary { background:#23232e; color:#e7e7ea; }
  input, textarea { width:100%; background:#0b0b0f; border:1px solid #2a2a36; border-radius:9px; padding:10px; color:#e7e7ea; font-family:ui-monospace,monospace; font-size:13px; resize:vertical; }
  .row { display:flex; gap:8px; margin-top:10px; }
  .pill { display:inline-block; font-size:11px; padding:2px 8px; border:1px solid #2a2a36; border-radius:999px; color:#9a9aa3; margin:2px 4px 2px 0; }
  a { color:#8a5cf6; }
  .bond { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 0; border-bottom:1px solid #1d1d26; font-size:13px; flex-wrap:wrap; }
  .bond:last-child { border-bottom:0; }
  .bond .who { font-family:ui-monospace,Menlo,monospace; }
  .bond .meta { color:#9a9aa3; font-size:12px; }
  .bond .actions { display:flex; gap:6px; }
  .bond .actions button { padding:6px 10px; font-size:12px; }
  .mutual { color:#5ad17f; font-weight:600; }
  .lock { font-size:12px; }
  .seg { display:flex; border:1px solid #2a2a36; border-radius:9px; overflow:hidden; margin-top:10px; }
  .seg button { flex:1; background:#0b0b0f; color:#9a9aa3; border-radius:0; font-weight:500; }
  .seg button.on { background:#23232e; color:#e7e7ea; font-weight:600; }
  .hint { font-size:12px; color:#6b6b76; margin:6px 0 0; }
  select { background:#0b0b0f; border:1px solid #2a2a36; border-radius:9px; padding:10px; color:#e7e7ea; font-size:13px; width:100%; }
  .addr { display:flex; gap:8px; align-items:center; }
  .addr code { flex:1; font-size:13px; word-break:break-all; background:#0b0b0f; border:1px solid #2a2a36; border-radius:9px; padding:10px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <svg width="34" height="34" viewBox="0 0 512 512"><rect width="512" height="512" rx="120" fill="#15151c"/><g fill="none" stroke-width="40" stroke-linecap="round"><circle cx="204" cy="256" r="104" stroke="#F7931A"/><circle cx="308" cy="256" r="104" stroke="#8A5CF6"/></g></svg>
    <div><h1>Pact</h1><div class="badge" id="ver">the agent relationship layer</div></div>
  </header>

  <div class="card" id="unlock-card" style="display:none"><h2>Locked</h2><div id="unlock"></div></div>
  <div class="card" id="identity-card"><h2>Your bond address</h2><div id="identity">Loading…</div></div>
  <div class="card" id="inbox-card" style="display:none"><h2>Needs your response</h2><div id="inbox"></div></div>
  <div class="card" id="bonds-card"><h2>Bonds</h2><div id="bonds">Loading…</div></div>
  <div class="card" id="form-card"><h2>Form a bond</h2><div id="formbond">Loading…</div></div>
  <div class="card" id="discover-card"><h2>Discover</h2><div id="discover">Loading…</div></div>
  <div class="card" id="wallet-card"><h2>Lightning wallet</h2><div id="wallet">Loading…</div></div>
  <div class="card" id="relays-card"><h2>Relays</h2><div id="relays">Loading…</div></div>
  <div class="card" id="agent-card" style="display:none"><h2>Connect an agent</h2><div id="agent"></div></div>

  <div class="badge muted" style="margin-top:20px">
    pactd · <a href="https://github.com/bobodread876/pact" target="_blank">docs</a> ·
    JSON API at <code>/healthz</code>, <code>/identity</code>, <code>/bonds</code>, <code>/wallet</code>
  </div>
</div>

<script>
// Embedded only behind an authenticating proxy (PACT_UI_EMBED_TOKEN); normally
// empty, and the token comes from the operator (sessionStorage / #token=).
const EMBEDDED = ${tokenLiteral};
// The token comes only from the operator (cached in sessionStorage), never
// from the served page.
let TOKEN = EMBEDDED || sessionStorage.getItem('pact_token') || '';
const PUBLIC_PORT = ${publicPortJson};
const RELAY_PUBLIC_PORT = ${relayPublicPortJson};
const el = (id) => document.getElementById(id);
// Builder shortcut: h('span', 'cls', 'text') — text always via textContent.
const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const kv = (k, valueNode) => {
  const d = h('div', 'kv');
  d.appendChild(h('span', 'k', k));
  d.appendChild(valueNode);
  return d;
};

async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) {
    const had = !!TOKEN;
    sessionStorage.removeItem('pact_token'); TOKEN = '';
    showUnlock(had ? 'That token was rejected — check it and try again.' : null);
    return { error: 'unauthorized', status: r.status };
  }
  try { return await r.json(); } catch { return { error: 'bad response', status: r.status }; }
}

// --- npub display (bech32 encode, NIP-19) — humans never see hex -------------
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bechPolymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function npubFromHex(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) return hex || '?';
  const bytes = hex.match(/../g).map(x => parseInt(x, 16));
  const words = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
  }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const hrp = 'npub';
  const exp = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31));
  const poly = bechPolymod(exp.concat(words, [0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((poly >> (5 * (5 - i))) & 31);
  return hrp + '1' + words.concat(checksum).map(w => B32[w]).join('');
}
const shortAddr = (hex) => { const n = npubFromHex(hex); return n.length > 21 ? n.slice(0, 13) + '\\u2026' + n.slice(-4) : n; };
function copyText(text, btn) {
  const done = (ok) => {
    const old = btn.textContent;
    btn.textContent = ok ? 'Copied \\u2713' : 'Copy failed \\u2014 select it manually';
    setTimeout(() => { btn.textContent = old; }, ok ? 1500 : 3000);
  };
  // navigator.clipboard requires a secure context (https / localhost); Umbrel
  // and LAN access are plain http, so fall back to execCommand there.
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  done(ok);
}

const DATA_CARDS = ['identity-card', 'bonds-card', 'form-card', 'discover-card', 'wallet-card', 'relays-card'];
let UNLOCK_SHOWN = false;
function showUnlock(msg) {
  DATA_CARDS.concat('agent-card', 'inbox-card').forEach(c => { el(c).style.display = 'none'; });
  el('unlock-card').style.display = '';
  if (UNLOCK_SHOWN) return; // don't wipe a half-typed token on the 20s poll
  UNLOCK_SHOWN = true;
  const box = el('unlock');
  const note = h('p', 'muted', msg ||
    'This node\\'s access token is never written into this page. Paste it here (it lives in your node config) to manage the node:');
  const input = h('input');
  input.id = 'tok';
  input.type = 'password';
  input.placeholder = 'access token';
  input.autocomplete = 'off';
  const row = h('div', 'row');
  const btn = h('button', null, 'Unlock');
  btn.addEventListener('click', () => {
    const t = input.value.trim();
    if (!t) return;
    sessionStorage.setItem('pact_token', t);
    TOKEN = t;
    UNLOCK_SHOWN = false;
    el('unlock-card').style.display = 'none';
    refresh();
  });
  row.appendChild(btn);
  box.replaceChildren(note, input, row);
}

// --- The bond flow (docs/BOND-FLOW.md) ---------------------------------------
// Situations are computed from the pair of sides per bond id; humans see the
// wording-table vocabulary, never protocol states or bond ids.

const ENDED_THEIRS = { revoked: 'Ended by them', rejected: 'Declined by them', withdrawn: 'Withdrawn by them', expired: 'Expired' };
const ENDED_MINE = { revoked: 'Ended', rejected: 'Declined', withdrawn: 'Withdrawn', expired: 'Expired' };

function situation(mine, theirs) {
  const m = mine && mine.state, t = theirs && theirs.state;
  if (t && ENDED_THEIRS[t]) return { label: ENDED_THEIRS[t], cls: 'muted', actions: [] };
  if (m && ENDED_MINE[m]) return { label: ENDED_MINE[m], cls: 'muted', actions: [] };
  if (m === 'paused' || t === 'paused') return { label: 'Paused', cls: 'warn', actions: m === 'paused' ? ['resume', 'end'] : ['end'] };
  const live = (s) => s === 'accepted' || s === 'active';
  if (live(m) && live(t)) return { label: '\\u25CF Mutual', cls: 'mutual', actions: ['reaffirm', 'pause', 'end'] };
  if (!m && t === 'proposed') return { label: 'They want to bond', cls: 'warn', actions: ['accept', 'decline'], inbox: true };
  if (m === 'proposed' && !t) return { label: 'Waiting for them', cls: 'muted', actions: ['withdraw'] };
  if (m === 'proposed' && live(t)) return { label: 'They accepted \\u2014 confirming\\u2026', cls: 'muted', actions: ['confirm', 'end'] };
  if (live(m) && (!t || t === 'proposed')) return { label: 'Waiting for them', cls: 'muted', actions: ['end'] };
  return { label: 'Unknown', cls: 'muted', actions: [] };
}

async function bondAction(action, g, myHex) {
  const counterparty = (g.mine && g.mine.counterparty) || (g.theirs && g.theirs.author);
  const priv = g.visibility === 'private';
  const post = (state) => api('POST', '/bonds', { counterparty, bondId: g.id, state, kind: g.kind || undefined, private: priv, history: !priv });
  if (action === 'reaffirm') return api('POST', '/bonds/reaffirm', { bondId: g.id });
  if (action === 'accept') return api('POST', '/bonds/accept', { bondId: g.id });
  if (action === 'decline') return api('POST', '/bonds/accept', { bondId: g.id, state: 'rejected' });
  if (action === 'confirm' || action === 'resume') return post('active');
  if (action === 'pause') return post('paused');
  if (action === 'withdraw') {
    if (!confirm('Withdraw this proposal?')) return null;
    return post('withdrawn');
  }
  if (action === 'end') {
    if (!confirm('End this bond? They keep their own record of it; yours is marked ended.')) return null;
    return post('revoked');
  }
  return null;
}

const ACTION_LABELS = { reaffirm: 'Reaffirm', accept: 'Accept', decline: 'Decline', confirm: 'Confirm', resume: 'Resume', pause: 'Pause', withdraw: 'Withdraw', end: 'End bond' };
const PRIMARY_ACTIONS = { accept: 1, confirm: 1, resume: 1, reaffirm: 1 };
const ACTION_TITLES = { reaffirm: 'Choose this bond again \\u2014 reaffirmations build its history: proof the relationship lasted, not just started.' };

function ago(unixSeconds) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 129600) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function bondRow(g, sit, myHex) {
  const who = (g.mine && g.mine.counterparty) || (g.theirs && g.theirs.author) || '';
  const row = h('div', 'bond');
  const left = h('div');
  const whoSpan = h('span', 'who', shortAddr(who));
  whoSpan.title = npubFromHex(who);
  left.appendChild(whoSpan);
  if (g.visibility === 'private') {
    const lock = h('span', 'lock', '\\uD83D\\uDD12');
    lock.title = 'Private \\u2014 only the two of you can see this bond exists';
    left.appendChild(document.createTextNode(' '));
    left.appendChild(lock);
  }
  if ([g.mine, g.theirs].some(s => s && !s.signature_valid)) {
    const bad = h('span', 'warn', '\\u26A0');
    bad.title = 'A side of this bond failed verification';
    left.appendChild(document.createTextNode(' '));
    left.appendChild(bad);
  }
  const meta = h('div', 'meta');
  meta.appendChild(h('span', sit.cls, sit.label));
  if (g.kind) meta.appendChild(document.createTextNode(' \\u00B7 ' + g.kind));
  if (g.reaffirm && (g.reaffirm.mine || g.reaffirm.theirs)) {
    const part = [];
    if (g.reaffirm.mine) part.push('you ' + ago(g.reaffirm.mine));
    if (g.reaffirm.theirs) part.push('them ' + ago(g.reaffirm.theirs));
    meta.appendChild(document.createTextNode(' \\u00B7 reaffirmed: ' + part.join(' \\u00B7 ')));
  }
  left.appendChild(meta);
  const actions = h('div', 'actions');
  for (const a of sit.actions) {
    const b = h('button', PRIMARY_ACTIONS[a] ? '' : 'secondary', ACTION_LABELS[a]);
    if (ACTION_TITLES[a]) b.title = ACTION_TITLES[a];
    b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '\\u2026';
      const res = await bondAction(a, g, myHex);
      if (res && res.error) alert(res.error);
      refresh();
    });
    actions.appendChild(b);
  }
  row.appendChild(left);
  row.appendChild(actions);
  return row;
}

let GROUPS = {};
let CURRENT_ID = null;
async function renderBonds(myHex, myNpub) {
  if (!myHex) {
    el('inbox-card').style.display = 'none';
    el('bonds').replaceChildren(h('p', 'muted', 'Create an identity first.'));
    renderForm(myHex, myNpub);
    return;
  }
  // Two views, merged: bonds I authored (+ my private inbox), bonds toward me.
  const [own, toward, reaff] = await Promise.all([
    api('GET', '/bonds'),
    api('GET', '/bonds?counterparty=' + encodeURIComponent(myNpub)),
    api('GET', '/reaffirmations'),
  ]);
  const rows = {};
  for (const r of ((own && own.bonds) || []).concat((toward && toward.bonds) || [])) {
    if (r && r.id && r.bond) rows[r.id + ':' + r.visibility] = r;
  }
  GROUPS = {};
  for (const key of Object.keys(rows)) {
    const r = rows[key];
    const g = GROUPS[r.bond] || (GROUPS[r.bond] = { id: r.bond, mine: null, theirs: null, visibility: 'public', kind: null });
    const side = r.author === myHex ? 'mine' : 'theirs';
    if (!g[side] || r.created_at > g[side].created_at) g[side] = r;
    if (r.visibility === 'private') g.visibility = 'private';
    if (r.kind && !g.kind) g.kind = r.kind;
  }

  for (const r of ((reaff && reaff.reaffirmations) || [])) {
    const g = GROUPS[r.bondId];
    if (!g) continue;
    g.reaffirm = g.reaffirm || {};
    const side = r.author === myHex ? 'mine' : 'theirs';
    if (!g.reaffirm[side] || r.at > g.reaffirm[side]) g.reaffirm[side] = r.at;
  }
  const groups = Object.values(GROUPS);
  const inbox = [], list = [];
  for (const g of groups) {
    const sit = situation(g.mine, g.theirs);
    (sit.inbox ? inbox : list).push(bondRow(g, sit, myHex));
  }
  el('inbox-card').style.display = inbox.length ? '' : 'none';
  el('inbox').replaceChildren(...inbox);
  el('bonds').replaceChildren(...(list.length ? list : [
    h('p', 'muted', 'No bonds yet. Share your bond address, or paste someone\\'s below to propose one.'),
  ]));
  renderForm(myHex, myNpub);
}

async function renderDiscover(myHex) {
  const box = el('discover');
  if (!myHex) { box.replaceChildren(h('p', 'muted', 'Create an identity first.')); return; }
  const [mine, board] = await Promise.all([api('GET', '/intent'), api('GET', '/discover')]);
  const intent = mine && mine.intent && mine.intent.status === 'open' ? mine.intent : null;

  box.replaceChildren();
  if (intent) {
    const p = h('p', 'muted');
    p.appendChild(document.createTextNode('You are findable \\u2014 seeking '));
    p.appendChild(h('b', null, (intent.seeking || []).join(', ')));
    if (intent.about) p.appendChild(document.createTextNode(' \\u00B7 \\u201C' + intent.about + '\\u201D'));
    box.appendChild(p);
    const row = h('div', 'row');
    const closeBtn = h('button', 'secondary', 'Unlist me');
    closeBtn.addEventListener('click', async () => {
      closeBtn.disabled = true;
      await api('POST', '/intent', { status: 'closed' });
      renderDiscover(myHex);
    });
    row.appendChild(closeBtn);
    box.appendChild(row);
  } else {
    box.appendChild(h('p', 'muted',
      'Publish an intent to appear on the open board. It reveals that you exist and what you seek \\u2014 never who you bond with.'));
    const about = h('input');
    about.placeholder = 'a line about this agent (optional)';
    about.maxLength = 200;
    box.appendChild(about);
    const kindWrap = h('div');
    kindWrap.style.marginTop = '10px';
    const kind = h('select');
    for (const k of ['companion', 'collaboration', 'team', 'guardian']) {
      const opt = h('option', null, 'seeking: ' + k);
      opt.value = k;
      kind.appendChild(opt);
    }
    kindWrap.appendChild(kind);
    box.appendChild(kindWrap);
    const row = h('div', 'row');
    const pub = h('button', null, 'Become findable');
    pub.addEventListener('click', async () => {
      pub.disabled = true;
      await api('POST', '/intent', { seeking: [kind.value], about: about.value.trim() || undefined });
      renderDiscover(myHex);
    });
    row.appendChild(pub);
    box.appendChild(row);
  }

  const listWrap = h('div');
  listWrap.style.marginTop = '14px';
  const candidates = ((board && board.candidates) || []).slice(0, 12);
  if (!candidates.length) {
    listWrap.appendChild(h('p', 'muted', 'No open intents on your relays yet.'));
  }
  for (const c of candidates) {
    const rowEl = h('div', 'bond');
    const left = h('div');
    const whoSpan = h('span', 'who', shortAddr(c.author));
    whoSpan.title = npubFromHex(c.author);
    left.appendChild(whoSpan);
    const meta = h('div', 'meta');
    meta.appendChild(document.createTextNode(
      'seeks ' + (c.seeking || []).join(', ') +
      ' \\u00B7 ' + c.record.bonds + ' bond' + (c.record.bonds === 1 ? '' : 's') +
      ' \\u00B7 ' + c.record.reaffirmations + ' reaffirmation' + (c.record.reaffirmations === 1 ? '' : 's')));
    if (c.about) {
      meta.appendChild(h('br'));
      meta.appendChild(document.createTextNode('\\u201C' + c.about + '\\u201D'));
    }
    left.appendChild(meta);
    const addr = npubFromHex(c.author);
    const actions = h('div', 'actions');
    const propose = h('button', null, 'Propose');
    propose.addEventListener('click', () => {
      const input = el('cp-addr');
      if (input) { input.value = addr; input.scrollIntoView({ behavior: 'smooth', block: 'center' }); input.focus(); }
    });
    actions.appendChild(propose);
    rowEl.appendChild(left);
    rowEl.appendChild(actions);
    listWrap.appendChild(rowEl);
  }
  box.appendChild(listWrap);
}

let FORM_VIS = 'private';
function renderForm(myHex, myNpub) {
  if (!myHex) { el('formbond').replaceChildren(h('p', 'muted', 'Create an identity first.')); return; }
  if (el('propose-btn')) return; // keep form state across refreshes
  // Fully static skeleton (no interpolated values) — safe as a markup string.
  el('formbond').innerHTML =
    '<p class="muted">Paste the other side\\'s bond address (they copy it from their own Pact page):</p>' +
    '<input id="cp-addr" placeholder="npub1\\u2026" autocomplete="off" />' +
    '<div class="seg"><button id="vis-private" class="on">Private</button><button id="vis-public">Public</button></div>' +
    '<p class="hint" id="vis-hint">Only the two of you can see this bond exists.</p>' +
    '<div style="margin-top:10px"><select id="cp-kind">' +
      '<option value="companion">companion</option><option value="collaboration">collaboration</option>' +
      '<option value="team">team</option><option value="guardian">guardian</option>' +
    '</select></div>' +
    '<div class="row"><button id="propose-btn">Propose bond</button></div>' +
    '<div class="badge muted" id="form-msg" style="margin-top:8px"></div>';
  const setVis = (v) => {
    FORM_VIS = v;
    el('vis-private').className = v === 'private' ? 'on' : '';
    el('vis-public').className = v === 'public' ? 'on' : '';
    el('vis-hint').textContent = v === 'private'
      ? 'Only the two of you can see this bond exists.'
      : 'Anyone can look this bond up \\u2014 useful when the relationship itself is a credential.';
  };
  el('vis-private').onclick = () => setVis('private');
  el('vis-public').onclick = () => setVis('public');
  el('propose-btn').onclick = async () => {
    const addr = el('cp-addr').value.trim();
    const msg = el('form-msg');
    if (!/^(npub1[02-9ac-hj-np-z]{58}|[0-9a-fA-F]{64}|did:nostr:npub1[02-9ac-hj-np-z]{58})$/.test(addr)) {
      msg.textContent = 'That doesn\\'t look like a bond address (npub\\u2026).'; return;
    }
    if (addr === myNpub || addr.toLowerCase() === myHex || addr === 'did:nostr:' + myNpub) {
      msg.textContent = 'That\\'s this node\\'s own address.'; return;
    }
    msg.textContent = 'Publishing\\u2026';
    el('propose-btn').disabled = true;
    const res = await api('POST', '/bonds', {
      counterparty: addr,
      kind: el('cp-kind').value,
      private: FORM_VIS === 'private',
      history: FORM_VIS !== 'private',
    });
    el('propose-btn').disabled = false;
    const accepted = res && res.stateEvent && res.stateEvent.relays
      ? res.stateEvent.relays.filter(r => r.accepted).length : 0;
    if (res && res.bondId && accepted > 0) {
      msg.textContent = 'Proposal sent \\u2014 waiting for them to accept.';
      el('cp-addr').value = '';
      refresh();
    } else if (res && res.bondId) {
      msg.textContent = 'Couldn\\'t reach any relay \\u2014 check the Relays card.';
    } else {
      msg.textContent = (res && res.error) || 'Failed to propose.';
    }
  };
}

async function refresh() {
  const health = await api('GET', '/healthz');
  el('ver').textContent = 'the agent relationship layer · v' + (health.version || '?');

  const id = await api('GET', '/identity');
  if (id && id.error === 'unauthorized') return; // api() already asked for the token
  DATA_CARDS.forEach(c => { el(c).style.display = ''; });
  const myHex = (id && id.pubkeyHex) || '';
  CURRENT_ID = id && id.did ? { hex: myHex, npub: id.npub } : null;
  if (id && id.did) {
    const ident = el('identity');
    ident.replaceChildren(
      h('p', 'muted', 'Share this with anyone you want to bond with \\u2014 like a Lightning address, it\\'s public and reusable.'));
    const addr = h('div', 'addr');
    addr.appendChild(h('code', null, id.npub));
    const copy = h('button', null, 'Copy');
    copy.addEventListener('click', () => copyText(id.npub, copy));
    addr.appendChild(copy);
    ident.appendChild(addr);
  } else {
    const ident = el('identity');
    ident.replaceChildren(
      h('p', 'muted', 'No identity yet \\u2014 this Pact node needs a key to form bonds.'));
    const keygen = h('button', null, 'Create identity');
    keygen.addEventListener('click', async () => { await api('POST', '/identity', {}); refresh(); });
    ident.appendChild(keygen);
  }

  const w = await api('GET', '/wallet');
  const walletBox = el('wallet');
  if (w && w.connected) {
    const caps = w.capabilities || {};
    walletBox.replaceChildren();
    const status = h('span', 'v ok', 'connected');
    if (w.info && w.info.alias) status.appendChild(document.createTextNode(' \\u00B7 ' + w.info.alias));
    walletBox.appendChild(kv('status', status));
    walletBox.appendChild(kv('backend', h('span', 'v', caps.backend || 'unknown')));
    walletBox.appendChild(kv('spendable (NWC)',
      h('span', 'v', w.balanceSats == null ? '\\u2014' : String(w.balanceSats) + ' sats')));
    const methods = h('div');
    methods.style.marginTop = '10px';
    for (const m of (caps.methods || [])) methods.appendChild(h('span', 'pill', m));
    walletBox.appendChild(methods);
    const row = h('div', 'row');
    const disc = h('button', 'secondary', 'Disconnect wallet');
    disc.addEventListener('click', async () => { await api('POST', '/wallet/disconnect', {}); refresh(); });
    row.appendChild(disc);
    walletBox.appendChild(row);
  } else {
    // Fully static skeleton (no interpolated values) — safe as a markup string.
    walletBox.innerHTML =
      '<p class="muted">Connect a Lightning wallet via Nostr Wallet Connect (Alby Hub, Coinos, Primal…). Create an app connection in your wallet and paste its <code>nostr+walletconnect://</code> URI:</p>' +
      '<input id="nwc" placeholder="nostr+walletconnect://..." />' +
      '<div class="row"><button id="connect">Connect wallet</button></div>' +
      '<div class="badge muted" id="nwc-msg" style="margin-top:8px"></div>';
    el('connect').onclick = async () => {
      const nwc = el('nwc').value.trim();
      if (!nwc) return;
      el('nwc-msg').textContent = 'Connecting…';
      const res = await api('POST', '/wallet/connect', { nwc });
      if (res && res.connected) refresh(); else el('nwc-msg').textContent = (res && res.error) || 'failed to connect';
    };
  }

  await renderBonds(myHex, id && id.npub);
  renderDiscover(myHex);

  const rl = await api('GET', '/relays');
  const relays = (rl && rl.relays) || [];
  const shareUrl = RELAY_PUBLIC_PORT ? ('ws://' + location.hostname + ':' + RELAY_PUBLIC_PORT) : '';
  const relayBox = el('relays');
  relayBox.replaceChildren();
  const pills = h('div');
  pills.style.marginBottom = '10px';
  for (const r of relays) pills.appendChild(h('span', 'pill', r));
  if (!(rl && rl.custom)) {
    pills.appendChild(document.createTextNode(' '));
    pills.appendChild(h('span', 'badge muted', '(defaults)'));
  }
  relayBox.appendChild(pills);
  if (shareUrl) {
    relayBox.appendChild(kv('bundled relay (shareable)', h('span', 'v', shareUrl)));
    const note = h('p', 'muted');
    note.appendChild(document.createTextNode('This node runs its own relay. Other agents on your network can use '));
    note.appendChild(h('code', null, shareUrl));
    note.appendChild(document.createTextNode('; reverse-proxy it (as '));
    note.appendChild(h('code', null, 'wss://'));
    note.appendChild(document.createTextNode(' with TLS) to publish it to the internet. Note: it accepts writes from anyone who can reach it.'));
    relayBox.appendChild(note);
  }
  const help = h('p', 'muted');
  help.appendChild(document.createTextNode('Where bonds are published & resolved. Use public relays, the relay bundled with Pact ('));
  help.appendChild(h('code', null, 'ws://relay:7777'));
  help.appendChild(document.createTextNode(' internally), or another relay app on your server. One per line:'));
  relayBox.appendChild(help);
  const relayInput = h('textarea');
  relayInput.rows = 3;
  relayInput.placeholder = 'wss://relay.example.com';
  relayInput.value = relays.join('\\n');
  relayBox.appendChild(relayInput);
  const relayMsg = h('div', 'badge muted');
  relayMsg.style.marginTop = '8px';
  const relayRow = h('div', 'row');
  const save = h('button', null, 'Save relays');
  save.addEventListener('click', async () => {
    const list = relayInput.value.split('\\n').map(s => s.trim()).filter(Boolean);
    if (!list.length) { relayMsg.textContent = 'enter at least one relay URL'; return; }
    relayMsg.textContent = 'Saving\\u2026';
    const res = await api('POST', '/relays', { relays: list });
    if (res && res.relays) refresh(); else relayMsg.textContent = (res && res.error) || 'failed to save relays';
  });
  relayRow.appendChild(save);
  if (rl && rl.custom) {
    const reset = h('button', 'secondary', 'Use public defaults');
    reset.addEventListener('click', async () => { await api('POST', '/relays', { relays: (rl && rl.default) || [] }); refresh(); });
    relayRow.appendChild(reset);
  }
  relayBox.appendChild(relayRow);
  relayBox.appendChild(relayMsg);

  if (TOKEN) {
    el('agent-card').style.display = '';
    const origin = PUBLIC_PORT ? (location.protocol + '//' + location.hostname + ':' + PUBLIC_PORT) : location.origin;
    const agentBox = el('agent');
    agentBox.replaceChildren();
    if (!TOKEN) {
      const p = h('p', 'muted');
      p.appendChild(document.createTextNode('Public mode \\u2014 the access token is not shown on this page. Take it from your node config (the '));
      p.appendChild(h('code', null, 'PACT_TOKEN'));
      p.appendChild(document.createTextNode(' you set, or '));
      p.appendChild(h('code', null, 'PACT_HOME/token'));
      p.appendChild(document.createTextNode(') and pass it to your agent:'));
      agentBox.appendChild(p);
      agentBox.appendChild(h('div', 'badge muted',
        'claude mcp add pact --env PACT_DAEMON_URL=' + origin + ' --env PACT_TOKEN=<your-token> -- npx -y pact-mcp'));
      const row = h('div', 'row');
      const lock = h('button', 'secondary', 'Lock this UI');
      lock.addEventListener('click', () => { sessionStorage.removeItem('pact_token'); location.reload(); });
      row.appendChild(lock);
      agentBox.appendChild(row);
    } else {
      agentBox.appendChild(h('p', 'muted', 'Point an MCP agent (Claude Code) at this node\\'s direct/API URL (bypasses the app login):'));
      agentBox.appendChild(kv('access token', h('span', 'v', TOKEN)));
      const cmd = h('div', 'badge muted',
        'claude mcp add pact --env PACT_DAEMON_URL=' + origin + ' --env PACT_TOKEN=' + TOKEN + ' -- npx -y pact-mcp');
      cmd.style.marginTop = '10px';
      agentBox.appendChild(cmd);
    }
  }
}

// Auto-unlock from a #token=… fragment (e.g. a launch link from the StartOS
// "Show access token" action), then scrub it from the URL/history. Hash (not
// query) so the token isn't sent to the server or written to access logs.
{
  const m = (location.hash || '').match(/(?:^#|&)token=([^&]+)/);
  if (m) {
    try { const t = decodeURIComponent(m[1]); sessionStorage.setItem('pact_token', t); TOKEN = t; } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
  }
}
refresh();
// Keep the inbox live without clobbering in-progress edits elsewhere on the
// page: poll only the bond views.
setInterval(() => { if (CURRENT_ID && TOKEN) renderBonds(CURRENT_ID.hex, CURRENT_ID.npub); }, 20000);
</script>
</body>
</html>`;
}
