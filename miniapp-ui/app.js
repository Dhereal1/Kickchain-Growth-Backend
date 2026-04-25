/* global Telegram */

function $(id) {
  return document.getElementById(id);
}

function setConn({ ok, text }) {
  const dot = $('connDot');
  const t = $('connText');
  if (dot) dot.classList.toggle('ok', !!ok);
  if (t) t.textContent = text || (ok ? 'Connected' : 'Disconnected');
}

function setFooter(text) {
  const el = $('footerText');
  if (el) el.textContent = String(text || '—');
}

function fmtNum(n, digits = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  return x.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function safeText(v) {
  return String(v == null ? '' : v);
}

function renderError(title, err) {
  const msg = err?.message || safeText(err);
  const details = err?.payload ? JSON.stringify(err.payload, null, 2) : '';

  const root = document.createElement('div');
  root.className = 'card';
  root.innerHTML = `
    <div class="hd"><h2>${title}</h2></div>
    <div class="bd">
      <div class="error">${escapeHtml(msg)}${details ? '\n\n' + escapeHtml(details) : ''}</div>
    </div>
  `;
  return root;
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setPanel(node) {
  const panel = $('panel');
  if (!panel) return;
  panel.innerHTML = '';
  panel.appendChild(node);
}

function applyTelegramTheme() {
  const tg = typeof Telegram !== 'undefined' ? Telegram.WebApp : null;
  if (!tg) return;

  const tp = tg.themeParams || {};
  // Minimal mapping to feel native; keep fallback palette when missing.
  const map = [
    ['--bg', tp.bg_color],
    ['--text', tp.text_color],
    ['--muted', tp.hint_color],
    ['--accent', tp.button_color],
    ['--accent2', tp.link_color],
  ];
  for (const [cssVar, val] of map) {
    if (val) document.documentElement.style.setProperty(cssVar, val);
  }
}

function getInitData() {
  const tg = typeof Telegram !== 'undefined' ? Telegram.WebApp : null;
  return tg?.initData || '';
}

function getStartParam() {
  const tg = typeof Telegram !== 'undefined' ? Telegram.WebApp : null;
  return tg?.initDataUnsafe?.start_param || null;
}

async function apiFetch(path, { method = 'GET', body = null, timeoutMs = 15000 } = {}) {
  const url = path;
  const initData = getInitData();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(initData ? { 'x-telegram-init-data': initData } : {}),
      },
      body: body ? JSON.stringify(body) : null,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { ok: false, error: 'non_json_response', text };
    }
    if (!res.ok) {
      const err = new Error(json?.error || json?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function kv(key, value) {
  const el = document.createElement('div');
  el.className = 'kv';
  el.innerHTML = `<div class="k">${escapeHtml(key)}</div><div class="v">${escapeHtml(value)}</div>`;
  return el;
}

function itemRow({ left, right, meta }) {
  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML = `
    <div class="t">
      <div class="name">${escapeHtml(left)}</div>
      <div class="pill2">${escapeHtml(right)}</div>
    </div>
    ${meta ? `<div class="m">${escapeHtml(meta)}</div>` : ''}
  `;
  return el;
}

function card(title, bodyNode) {
  const el = document.createElement('div');
  el.className = 'card';
  const hd = document.createElement('div');
  hd.className = 'hd';
  const h2 = document.createElement('h2');
  h2.textContent = title;
  hd.appendChild(h2);
  const bd = document.createElement('div');
  bd.className = 'bd';
  bd.appendChild(bodyNode);
  el.appendChild(hd);
  el.appendChild(bd);
  return el;
}

async function loadMe() {
  const startParam = getStartParam();
  const data = await apiFetch('/miniapp/api/me', {
    method: 'POST',
    body: startParam ? { start_param: startParam } : {},
  });
  return data;
}

async function showLeaderboard() {
  setFooter('Leaderboard');
  const data = await apiFetch('/miniapp/api/leaderboard');
  const rows = Array.isArray(data?.leaderboard) ? data.leaderboard : [];

  const root = document.createElement('div');
  root.className = 'row';

  const list = document.createElement('div');
  list.className = 'list';
  if (!rows.length) {
    list.appendChild(itemRow({ left: 'No data yet', right: '—', meta: 'Play and refer friends to climb.' }));
  } else {
    rows.forEach((r, idx) => {
      list.appendChild(
        itemRow({
          left: `${idx + 1}. @${String(r.username || '').replace(/^@/, '') || 'unknown'}`,
          right: `${fmtNum(r.total_referrals || 0)} refs`,
          meta: `Tier: ${safeText(r.tier || '—')} • Code: ${safeText(r.referral_code || '—')}`,
        })
      );
    });
  }

  root.appendChild(card('Top Referrers', list));
  setPanel(root);
}

async function showMyStats() {
  setFooter('My Stats');
  const me = await loadMe();
  const stats = me?.stats || {};
  const profile = me?.profile || {};

  const root = document.createElement('div');
  root.className = 'row';

  const kvs = document.createElement('div');
  kvs.className = 'kvs';
  kvs.appendChild(kv('Username', profile.username ? `@${String(profile.username).replace(/^@/, '')}` : '—'));
  kvs.appendChild(kv('Tier', safeText(stats.tier || profile.tier || '—')));
  kvs.appendChild(kv('Rank (Referrals)', fmtNum(stats.rank || 0)));
  kvs.appendChild(kv('Total Referrals', fmtNum(stats.total_referrals || 0)));
  kvs.appendChild(kv('Matches Played', fmtNum(stats.matches_played || 0)));
  kvs.appendChild(kv('Wins', fmtNum(stats.wins || 0)));
  kvs.appendChild(kv('Total Won', fmtNum(stats.total_won || 0)));

  root.appendChild(card('Profile', kvs));

  const actions = document.createElement('div');
  actions.className = 'row';
  const btns = document.createElement('div');
  btns.className = 'btns';
  const btnCopy = document.createElement('button');
  btnCopy.className = 'btn primary';
  btnCopy.textContent = 'Copy Referral Link';
  btnCopy.onclick = async () => {
    const link = me?.referral_link || '';
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setFooter('Copied referral link');
      setTimeout(() => setFooter('My Stats'), 1200);
    } catch {
      // fallback
      prompt('Copy your referral link:', link);
    }
  };
  btns.appendChild(btnCopy);

  const btnOpenBot = document.createElement('button');
  btnOpenBot.className = 'btn';
  btnOpenBot.textContent = 'Open Bot';
  btnOpenBot.onclick = () => {
    const tg = typeof Telegram !== 'undefined' ? Telegram.WebApp : null;
    const link = me?.bot_link || '';
    if (tg && link) tg.openTelegramLink(link);
  };
  btns.appendChild(btnOpenBot);

  actions.appendChild(btns);
  actions.appendChild(
    (() => {
      const p = document.createElement('div');
      p.className = 'hint';
      p.textContent = me?.referral_link
        ? `Share: ${me.referral_link}`
        : 'Set BOT_USERNAME on the backend to enable a shareable referral link.';
      return p;
    })()
  );

  root.appendChild(card('Referral', actions));
  setPanel(root);
}

async function claimDaily() {
  return await apiFetch('/miniapp/api/daily', { method: 'POST', body: {} });
}

function badgePill(def, owned) {
  const el = document.createElement('div');
  el.className = 'item';
  const ok = owned;
  el.innerHTML = `
    <div class="t">
      <div class="name">${escapeHtml(def.name)}</div>
      <div class="pill2">${ok ? 'Unlocked' : 'Locked'}</div>
    </div>
    <div class="m">${escapeHtml(def.desc)}</div>
  `;
  return el;
}

async function showProgress() {
  setFooter('Progress');
  const me = await loadMe();
  const stats = me?.stats || {};

  const xp = Number(stats.xp || 0);
  const level = Number(stats.level || 1);
  const nextXp = Number(stats.next_level_xp || 0);
  const toNext = Math.max(0, nextXp - xp);
  const pct = Math.max(0, Math.min(1, Number(stats.level_progress_pct || 0)));

  const root = document.createElement('div');
  root.className = 'row';

  const box = document.createElement('div');
  box.className = 'row';
  box.appendChild(kv('Level', safeText(level)));
  box.appendChild(kv('XP', `${fmtNum(xp)} / ${fmtNum(nextXp)} (${fmtNum(Math.round(pct * 100))}%)`));
  box.appendChild(kv('Next Level', toNext ? `${fmtNum(toNext)} XP to go` : 'Maxed'));
  if (stats?.nudges?.next_tier && stats?.nudges?.refs_needed_for_next_tier) {
    const n = Number(stats.nudges.refs_needed_for_next_tier || 0);
    box.appendChild(kv('Tier Nudge', `${n} referral${n === 1 ? '' : 's'} to ${safeText(stats.nudges.next_tier)}`));
  }

  const dailyRow = document.createElement('div');
  dailyRow.className = 'row';
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = 'Claim Daily XP';
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await claimDaily();
      const claimed = !!r?.claimed;
      const xpAwarded = Number(r?.xp_awarded || 0);
      setFooter(claimed ? `Claimed +${xpAwarded} XP` : 'Already claimed today');
      await showProgress();
    } catch (err) {
      setFooter('Daily claim failed');
      setPanel(renderError('Daily claim failed', err));
    } finally {
      btn.disabled = false;
    }
  };
  dailyRow.appendChild(btn);
  dailyRow.appendChild(
    (() => {
      const p = document.createElement('div');
      p.className = 'hint';
      p.textContent = `Daily streak: ${fmtNum(stats.daily_check_streak || 0)} day(s)`;
      return p;
    })()
  );

  const badgesCard = document.createElement('div');
  badgesCard.className = 'row';
  const list = document.createElement('div');
  list.className = 'list';
  const ownedKeys = new Set((Array.isArray(stats.badges) ? stats.badges : []).map((b) => String(b.badge_key)));
  const defs = [
    { key: 'ref_3', name: 'Connector', desc: 'Get 3 referrals' },
    { key: 'ref_10', name: 'Influencer', desc: 'Get 10 referrals' },
    { key: 'win_3', name: 'Streak Starter', desc: 'Reach a 3-win streak' },
    { key: 'win_10', name: 'Champion', desc: 'Win 10 matches' },
    { key: 'daily_3', name: 'Regular', desc: '3-day daily check-in streak' },
    { key: 'daily_7', name: 'Daily Grinder', desc: '7-day daily check-in streak' },
  ];
  defs.forEach((d) => list.appendChild(badgePill(d, ownedKeys.has(d.key))));
  badgesCard.appendChild(card('Badges', list));

  const unlocks = document.createElement('div');
  unlocks.className = 'row';
  const unlockList = document.createElement('div');
  unlockList.className = 'list';
  const unlockedTourneys = level >= 5;
  unlockList.appendChild(
    itemRow({
      left: 'Private Tournaments',
      right: unlockedTourneys ? 'Unlocked' : 'Locked',
      meta: unlockedTourneys ? 'Create invite-only tournaments for your squad.' : 'Unlocks at Level 5.',
    })
  );
  if (unlockedTourneys) {
    const btnCreate = document.createElement('button');
    btnCreate.className = 'btn';
    btnCreate.textContent = 'Create Private Tournament';
    btnCreate.onclick = async () => {
      btnCreate.disabled = true;
      try {
        const r = await apiFetch('/miniapp/api/tournaments/private/create', { method: 'POST', body: { title: 'Private Tournament' } });
        const t = r?.tournament || null;
        if (t?.invite_code) {
          alert(`Tournament created!\nInvite code: ${t.invite_code}`);
        }
      } catch (err) {
        setPanel(renderError('Create tournament failed', err));
      } finally {
        btnCreate.disabled = false;
      }
    };
    unlockList.appendChild(btnCreate);
  }
  unlocks.appendChild(card('Unlockables', unlockList));

  root.appendChild(card('XP Progression', box));
  root.appendChild(card('Daily', dailyRow));
  root.appendChild(badgesCard);
  root.appendChild(unlocks);
  setPanel(root);
}

async function showReferrals() {
  setFooter('Referrals');
  const data = await apiFetch('/miniapp/api/referrals');
  const items = Array.isArray(data?.referrals) ? data.referrals : [];

  const root = document.createElement('div');
  root.className = 'row';

  const list = document.createElement('div');
  list.className = 'list';
  if (!items.length) {
    list.appendChild(itemRow({ left: 'No referrals yet', right: '—', meta: 'Copy your referral link and share it.' }));
  } else {
    items.forEach((r) => {
      list.appendChild(
        itemRow({
          left: r.username ? `@${String(r.username).replace(/^@/, '')}` : 'no_username',
          right: safeText(r.created_at || '—'),
          meta: r.tier ? `Tier: ${r.tier}` : null,
        })
      );
    });
  }

  root.appendChild(card(`Recent Referrals (${fmtNum(items.length)})`, list));
  setPanel(root);
}

function setActiveTab(tab) {
  const buttons = document.querySelectorAll('[data-tab]');
  buttons.forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
}

async function route(tab) {
  setActiveTab(tab);
  try {
    setConn({ ok: true, text: 'Connected' });
    if (tab === 'leaderboard') return await showLeaderboard();
    if (tab === 'progress') return await showProgress();
    if (tab === 'me') return await showMyStats();
    if (tab === 'referrals') return await showReferrals();
    return await showLeaderboard();
  } catch (err) {
    setConn({ ok: false, text: 'Error' });
    setPanel(renderError('Something went wrong', err));
  }
}

function init() {
  applyTelegramTheme();
  try {
    const tg = typeof Telegram !== 'undefined' ? Telegram.WebApp : null;
    if (tg) {
      tg.ready();
      tg.expand();
      tg.onEvent('themeChanged', applyTelegramTheme);
    }
  } catch {
    // ignore
  }

  const tabs = document.querySelectorAll('[data-tab]');
  tabs.forEach((b) => {
    b.addEventListener('click', () => route(b.getAttribute('data-tab')));
  });

  const btnRefresh = $('btnRefresh');
  if (btnRefresh) btnRefresh.onclick = () => {
    const active = document.querySelector('[data-tab].active');
    const tab = active ? active.getAttribute('data-tab') : 'leaderboard';
    route(tab);
  };

  const btnClose = $('btnClose');
  if (btnClose) btnClose.onclick = () => {
    const tg = typeof Telegram !== 'undefined' ? Telegram.WebApp : null;
    if (tg) tg.close();
  };

  route('leaderboard');
}

init();
