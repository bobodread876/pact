// Minimal self-contained status UI served at / by pactd. No build step, no deps:
// a single HTML page whose JS calls the existing JSON endpoints (same origin).
// On Umbrel it's reached through app_proxy (Umbrel auth); the optional bearer
// token (if PACT_TOKEN is set) is injected so the UI's API calls authenticate.

export function renderUI(
  token: string | undefined,
  publicPort?: string,
  relayPublicPort?: string,
  publicMode = false,
): string {
  // In public mode the token is NEVER written into the page (the operator enters
  // it; agents read it from the node config). Otherwise it's injected so the UI's
  // same-origin API calls authenticate — fine behind a trusted LAN / app login.
  const tokenLiteral = publicMode ? '""' : JSON.stringify(token ?? '');
  const publicPortJson = JSON.stringify(publicPort ?? '');
  const relayPublicPortJson = JSON.stringify(relayPublicPort ?? '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
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
const PUBLIC_MODE = ${publicMode ? 'true' : 'false'};
// Public mode: token comes from the operator (cached in sessionStorage), never
// from the page. Otherwise it's the injected token (empty string in public mode).
let TOKEN = PUBLIC_MODE ? (sessionStorage.getItem('pact_token') || '') : ${tokenLiteral};
const PUBLIC_PORT = ${publicPortJson};
const RELAY_PUBLIC_PORT = ${relayPublicPortJson};
async function api(method, path, body) {
  const h = { 'content-type': 'application/json' };
  if (TOKEN) h.authorization = 'Bearer ' + TOKEN;
  const r = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  try { return await r.json(); } catch { return { error: 'bad response', status: r.status }; }
}
const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

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
  const bytes = hex.match(/../g).map(h => parseInt(h, 16));
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
function showUnlock(msg) {
  DATA_CARDS.concat('agent-card', 'inbox-card').forEach(c => { el(c).style.display = 'none'; });
  el('unlock-card').style.display = '';
  el('unlock').innerHTML =
    '<p class="muted">' + (msg || 'This node runs in public mode — its access token is never shown on this page. Enter it (it lives in your node config) to manage the node:') + '</p>' +
    '<input id="tok" type="password" placeholder="access token" autocomplete="off" />' +
    '<div class="row"><button id="unlock-btn">Unlock</button></div>';
  el('unlock-btn').onclick = () => {
    const t = el('tok').value.trim();
    if (!t) return;
    sessionStorage.setItem('pact_token', t);
    TOKEN = t;
    el('unlock-card').style.display = 'none';
    refresh();
  };
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
  const lock = g.visibility === 'private' ? ' <span class="lock" title="Private \\u2014 only the two of you can see this bond exists">\\uD83D\\uDD12</span>' : '';
  const bad = [g.mine, g.theirs].some(s => s && !s.signature_valid) ? ' <span class="warn" title="A side of this bond failed verification">\\u26A0</span>' : '';
  const kind = g.kind ? ' \\u00B7 ' + esc(g.kind) : '';
  const buttons = sit.actions.map(a =>
    '<button class="' + (PRIMARY_ACTIONS[a] ? '' : 'secondary') + '"' + (ACTION_TITLES[a] ? ' title="' + ACTION_TITLES[a] + '"' : '') + ' data-act="' + a + '" data-bond="' + esc(g.id) + '">' + ACTION_LABELS[a] + '</button>').join('');
  let chosen = '';
  if (g.reaffirm && (g.reaffirm.mine || g.reaffirm.theirs)) {
    const part = [];
    if (g.reaffirm.mine) part.push('you ' + ago(g.reaffirm.mine));
    if (g.reaffirm.theirs) part.push('them ' + ago(g.reaffirm.theirs));
    chosen = ' \\u00B7 reaffirmed: ' + part.join(' \\u00B7 ');
  }
  return '<div class="bond"><div>' +
    '<span class="who" title="' + esc(npubFromHex(who)) + '">' + esc(shortAddr(who)) + '</span>' + lock + bad +
    '<div class="meta"><span class="' + sit.cls + '">' + sit.label + '</span>' + kind + chosen + '</div></div>' +
    '<div class="actions">' + buttons + '</div></div>';
}

let GROUPS = {};
let CURRENT_ID = null;
async function renderBonds(myHex, myNpub) {
  if (!myHex) {
    el('inbox-card').style.display = 'none';
    el('bonds').innerHTML = '<p class="muted">Create an identity first.</p>';
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
  el('inbox').innerHTML = inbox.join('');
  el('bonds').innerHTML = list.length
    ? list.join('')
    : '<p class="muted">No bonds yet. Share your bond address, or paste someone\\'s below to propose one.</p>';

  for (const btn of document.querySelectorAll('button[data-act]')) {
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '\\u2026';
      const g = GROUPS[btn.getAttribute('data-bond')];
      const res = g && await bondAction(btn.getAttribute('data-act'), g, myHex);
      if (res && res.error) alert(res.error);
      refresh();
    };
  }
  renderForm(myHex, myNpub);
}

async function renderDiscover(myHex) {
  const box = el('discover');
  if (!myHex) { box.innerHTML = '<p class="muted">Create an identity first.</p>'; return; }
  const [mine, board] = await Promise.all([api('GET', '/intent'), api('GET', '/discover')]);

  const intent = mine && mine.intent && mine.intent.status === 'open' ? mine.intent : null;
  let html = intent
    ? '<p class="muted">You are findable — seeking <b>' + esc((intent.seeking || []).join(', ')) + '</b>' +
      (intent.about ? ' · \u201C' + esc(intent.about) + '\u201D' : '') + '</p>' +
      '<div class="row"><button class="secondary" id="intent-close">Unlist me</button></div>'
    : '<p class="muted">Publish an intent to appear on the open board. It reveals that you exist and what you seek \u2014 never who you bond with.</p>' +
      '<input id="intent-about" placeholder="a line about this agent (optional)" maxlength="200" />' +
      '<div style="margin-top:10px"><select id="intent-kind">' +
        '<option value="companion">seeking: companion</option><option value="collaboration">seeking: collaboration</option>' +
        '<option value="team">seeking: team</option><option value="guardian">seeking: guardian</option>' +
      '</select></div>' +
      '<div class="row"><button id="intent-pub">Become findable</button></div>';

  const rows = ((board && board.candidates) || []).slice(0, 12).map((c) =>
    '<div class="bond"><div>' +
      '<span class="who" title="' + esc(npubFromHex(c.author)) + '">' + esc(shortAddr(c.author)) + '</span>' +
      '<div class="meta">seeks ' + esc((c.seeking || []).join(', ')) +
        ' \u00B7 ' + c.record.bonds + ' bond' + (c.record.bonds === 1 ? '' : 's') +
        ' \u00B7 ' + c.record.reaffirmations + ' reaffirmation' + (c.record.reaffirmations === 1 ? '' : 's') +
        (c.about ? '<br/>\u201C' + esc(c.about) + '\u201D' : '') + '</div></div>' +
      '<div class="actions"><button data-propose="' + esc(npubFromHex(c.author)) + '">Propose</button></div></div>'
  );
  html += '<div style="margin-top:14px">' + (rows.length ? rows.join('') :
    '<p class="muted">No open intents on your relays yet.</p>') + '</div>';
  box.innerHTML = html;

  const pub = el('intent-pub');
  if (pub) pub.onclick = async () => {
    pub.disabled = true;
    await api('POST', '/intent', { seeking: [el('intent-kind').value], about: el('intent-about').value.trim() || undefined });
    renderDiscover(myHex);
  };
  const close = el('intent-close');
  if (close) close.onclick = async () => { close.disabled = true; await api('POST', '/intent', { status: 'closed' }); renderDiscover(myHex); };
  for (const b of box.querySelectorAll('button[data-propose]')) {
    b.onclick = () => {
      const addr = b.getAttribute('data-propose');
      const input = el('cp-addr');
      if (input) { input.value = addr; input.scrollIntoView({ behavior: 'smooth', block: 'center' }); input.focus(); }
    };
  }
}

let FORM_VIS = 'private';
function renderForm(myHex, myNpub) {
  if (!myHex) { el('formbond').innerHTML = '<p class="muted">Create an identity first.</p>'; return; }
  if (el('propose-btn')) return; // keep form state across refreshes
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

  if (PUBLIC_MODE && !TOKEN) { showUnlock(); return; }

  const id = await api('GET', '/identity');
  if (PUBLIC_MODE && id && id.error === 'unauthorized') {
    sessionStorage.removeItem('pact_token'); TOKEN = '';
    showUnlock('That token was rejected — check it and try again.');
    return;
  }
  DATA_CARDS.forEach(c => { el(c).style.display = ''; });
  const myHex = (id && id.pubkeyHex) || '';
  CURRENT_ID = id && id.did ? { hex: myHex, npub: id.npub } : null;
  if (id && id.did) {
    el('identity').innerHTML =
      '<p class="muted">Share this with anyone you want to bond with — like a Lightning address, it\\'s public and reusable.</p>' +
      '<div class="addr"><code>' + esc(id.npub) + '</code><button id="copy-addr">Copy</button></div>';
    el('copy-addr').onclick = (e) => copyText(id.npub, e.target);
  } else {
    el('identity').innerHTML = '<p class="muted">No identity yet — this Pact node needs a key to form bonds.</p>' +
      '<button id="keygen">Create identity</button>';
    el('keygen').onclick = async () => { await api('POST', '/identity', {}); refresh(); };
  }

  const w = await api('GET', '/wallet');
  if (w && w.connected) {
    const caps = w.capabilities || {};
    el('wallet').innerHTML =
      '<div class="kv"><span class="k">status</span><span class="v ok">connected' + (w.info && w.info.alias ? ' · ' + esc(w.info.alias) : '') + '</span></div>' +
      '<div class="kv"><span class="k">backend</span><span class="v">' + esc(caps.backend || 'unknown') + '</span></div>' +
      '<div class="kv"><span class="k">spendable (NWC)</span><span class="v">' + (w.balanceSats==null?'—':esc(w.balanceSats)+' sats') + '</span></div>' +
      '<div style="margin-top:10px">' + (caps.methods||[]).map(m=>'<span class="pill">'+esc(m)+'</span>').join('') + '</div>' +
      '<div class="row"><button class="secondary" id="disconnect">Disconnect wallet</button></div>';
    el('disconnect').onclick = async () => { await api('POST', '/wallet/disconnect', {}); refresh(); };
  } else {
    el('wallet').innerHTML =
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
  el('relays').innerHTML =
    '<div style="margin-bottom:10px">' + relays.map(r=>'<span class="pill">'+esc(r)+'</span>').join('') +
      (rl && rl.custom ? '' : ' <span class="badge muted">(defaults)</span>') + '</div>' +
    (shareUrl
      ? '<div class="kv"><span class="k">bundled relay (shareable)</span><span class="v">' + esc(shareUrl) + '</span></div>' +
        '<p class="muted">This node runs its own relay. Other agents on your network can use <code>' + esc(shareUrl) + '</code>; reverse-proxy it (as <code>wss://</code> with TLS) to publish it to the internet. Note: it accepts writes from anyone who can reach it.</p>'
      : '') +
    '<p class="muted">Where bonds are published &amp; resolved. Use public relays, the relay bundled with Pact (<code>ws://relay:7777</code> internally), or another relay app on your server. One per line:</p>' +
    '<textarea id="relay-input" rows="3" placeholder="wss://relay.example.com">' + esc(relays.join('\\n')) + '</textarea>' +
    '<div class="row"><button id="save-relays">Save relays</button>' +
      (rl && rl.custom ? '<button class="secondary" id="reset-relays">Use public defaults</button>' : '') + '</div>' +
    '<div class="badge muted" id="relay-msg" style="margin-top:8px"></div>';
  el('save-relays').onclick = async () => {
    const list = el('relay-input').value.split('\\n').map(s=>s.trim()).filter(Boolean);
    if (!list.length) { el('relay-msg').textContent = 'enter at least one relay URL'; return; }
    el('relay-msg').textContent = 'Saving…';
    const res = await api('POST', '/relays', { relays: list });
    if (res && res.relays) refresh(); else el('relay-msg').textContent = (res && res.error) || 'failed to save relays';
  };
  const resetBtn = el('reset-relays');
  if (resetBtn) resetBtn.onclick = async () => { await api('POST', '/relays', { relays: (rl && rl.default) || [] }); refresh(); };

  if (TOKEN) {
    el('agent-card').style.display = '';
    const origin = PUBLIC_PORT ? (location.protocol + '//' + location.hostname + ':' + PUBLIC_PORT) : location.origin;
    if (PUBLIC_MODE) {
      el('agent').innerHTML =
        '<p class="muted">Public mode — the access token is not shown on this page. Take it from your node config (the <code>PACT_TOKEN</code> you set, or <code>PACT_HOME/token</code>) and pass it to your agent:</p>' +
        '<div class="badge muted">claude mcp add pact --env PACT_DAEMON_URL=' + esc(origin) + ' --env PACT_TOKEN=&lt;your-token&gt; -- npx -y pact-mcp</div>' +
        '<div class="row"><button class="secondary" id="lock-btn">Lock this UI</button></div>';
      el('lock-btn').onclick = () => { sessionStorage.removeItem('pact_token'); location.reload(); };
    } else {
      el('agent').innerHTML =
        '<p class="muted">Point an MCP agent (Claude Code) at this node\\'s direct/API URL (bypasses the app login):</p>' +
        '<div class="kv"><span class="k">access token</span><span class="v">' + esc(TOKEN) + '</span></div>' +
        '<div class="badge muted" style="margin-top:10px">claude mcp add pact --env PACT_DAEMON_URL=' + esc(origin) + ' --env PACT_TOKEN=' + esc(TOKEN) + ' -- npx -y pact-mcp</div>';
    }
  }
}

// Public mode: auto-unlock from a #token=… fragment (e.g. a launch link from the
// StartOS "Show access token" action), then scrub it from the URL/history. Hash
// (not query) so the token isn't sent to the server or written to access logs.
if (PUBLIC_MODE) {
  const m = (location.hash || '').match(/(?:^#|&)token=([^&]+)/);
  if (m) {
    try { const t = decodeURIComponent(m[1]); sessionStorage.setItem('pact_token', t); TOKEN = t; } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
  }
}
refresh();
// Keep the inbox live without clobbering in-progress edits elsewhere on the
// page: poll only the bond views.
setInterval(() => { if (CURRENT_ID && (!PUBLIC_MODE || TOKEN)) renderBonds(CURRENT_ID.hex, CURRENT_ID.npub); }, 20000);
</script>
</body>
</html>`;
}
