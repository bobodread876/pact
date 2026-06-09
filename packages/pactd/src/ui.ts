// Minimal self-contained status UI served at / by pactd. No build step, no deps:
// a single HTML page whose JS calls the existing JSON endpoints (same origin).
// On Umbrel it's reached through app_proxy (Umbrel auth); the optional bearer
// token (if PACT_TOKEN is set) is injected so the UI's API calls authenticate.

export function renderUI(token: string | undefined, publicPort?: string): string {
  const tokenJson = JSON.stringify(token ?? '');
  const publicPortJson = JSON.stringify(publicPort ?? '');
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
  input { width:100%; background:#0b0b0f; border:1px solid #2a2a36; border-radius:9px; padding:10px; color:#e7e7ea; font-family:ui-monospace,monospace; font-size:13px; }
  .row { display:flex; gap:8px; margin-top:10px; }
  .pill { display:inline-block; font-size:11px; padding:2px 8px; border:1px solid #2a2a36; border-radius:999px; color:#9a9aa3; margin:2px 4px 2px 0; }
  a { color:#8a5cf6; }
  .bond { padding:8px 0; border-bottom:1px solid #1d1d26; font-size:13px; }
  .bond:last-child { border-bottom:0; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <svg width="34" height="34" viewBox="0 0 512 512"><rect width="512" height="512" rx="120" fill="#15151c"/><g fill="none" stroke-width="40" stroke-linecap="round"><circle cx="204" cy="256" r="104" stroke="#F7931A"/><circle cx="308" cy="256" r="104" stroke="#8A5CF6"/></g></svg>
    <div><h1>Pact</h1><div class="badge" id="ver">the agent relationship layer</div></div>
  </header>

  <div class="card" id="identity-card"><h2>Identity</h2><div id="identity">Loading…</div></div>
  <div class="card" id="wallet-card"><h2>Lightning wallet</h2><div id="wallet">Loading…</div></div>
  <div class="card" id="bonds-card"><h2>Bonds</h2><div id="bonds">Loading…</div></div>
  <div class="card" id="agent-card" style="display:none"><h2>Connect an agent</h2><div id="agent"></div></div>

  <div class="badge muted" style="margin-top:20px">
    pactd · <a href="https://github.com/bobodread876/pact" target="_blank">docs</a> ·
    JSON API at <code>/healthz</code>, <code>/identity</code>, <code>/bonds</code>, <code>/wallet</code>
  </div>
</div>

<script>
const TOKEN = ${tokenJson};
const PUBLIC_PORT = ${publicPortJson};
async function api(method, path, body) {
  const h = { 'content-type': 'application/json' };
  if (TOKEN) h.authorization = 'Bearer ' + TOKEN;
  const r = await fetch(path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  try { return await r.json(); } catch { return { error: 'bad response', status: r.status }; }
}
const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

async function refresh() {
  const health = await api('GET', '/healthz');
  el('ver').textContent = 'the agent relationship layer · v' + (health.version || '?');

  const id = await api('GET', '/identity');
  if (id && id.did) {
    el('identity').innerHTML =
      '<div class="kv"><span class="k">did</span><span class="v">' + esc(id.did) + '</span></div>' +
      '<div class="kv"><span class="k">npub</span><span class="v">' + esc(id.npub) + '</span></div>';
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

  const b = await api('GET', '/bonds');
  const bonds = (b && b.bonds) || [];
  el('bonds').innerHTML = bonds.length
    ? bonds.map(x => '<div class="bond"><span class="' + (x.signature_valid?'ok':'warn') + '">●</span> ' +
        esc(x.state||'?') + ' · ' + esc(x.bond||'') + '</div>').join('')
    : '<p class="muted">No bonds yet. Form one with the <code>pact_form_bond</code> tool or <code>POST /bonds</code>.</p>';

  if (TOKEN) {
    el('agent-card').style.display = '';
    const origin = PUBLIC_PORT ? (location.protocol + '//' + location.hostname + ':' + PUBLIC_PORT) : location.origin;
    el('agent').innerHTML =
      '<p class="muted">Point an MCP agent (Claude Code) at this node\\'s direct/API URL (bypasses the app login):</p>' +
      '<div class="kv"><span class="k">access token</span><span class="v">' + esc(TOKEN) + '</span></div>' +
      '<div class="badge muted" style="margin-top:10px">claude mcp add pact --env PACT_DAEMON_URL=' + esc(origin) + ' --env PACT_TOKEN=' + esc(TOKEN) + ' -- npx -y pact-mcp</div>';
  }
}
refresh();
</script>
</body>
</html>`;
}
