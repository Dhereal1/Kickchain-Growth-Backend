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

async function showFeed() {
  setFooter('Feed');
  const data = await apiFetch('/miniapp/api/hype/feed?limit=20');
  const items = Array.isArray(data?.items) ? data.items : [];

  const root = document.createElement('div');
  root.className = 'row';

  const list = document.createElement('div');
  list.className = 'list';

  if (!items.length) {
    list.appendChild(itemRow({ left: 'No hype yet', right: '—', meta: 'Win matches to trigger hype events.' }));
  } else {
    items.forEach((e) => {
      list.appendChild(
        itemRow({
          left: `Match #${safeText(e.match_id)} · stake ${safeText(e.stake_amount || 0)}`,
          right: safeText(e.sent_at || e.created_at || '—'),
          meta: safeText(e.hype_text || ''),
        })
      );
    });
  }

  const actions = document.createElement('div');
  actions.className = 'row';
  const btns = document.createElement('div');
  btns.className = 'btns';

  const btnLatest = document.createElement('button');
  btnLatest.className = 'btn';
  btnLatest.textContent = 'My Latest Win Share';
  btnLatest.onclick = async () => {
    btnLatest.disabled = true;
    try {
      const latest = await apiFetch('/miniapp/api/hype/latest');
      const item = latest?.item || null;
      if (!item?.hype_text) {
        alert('No recent win share found yet.');
        return;
      }
      try {
        await navigator.clipboard.writeText(String(item.hype_text));
        setFooter('Copied win share text');
        setTimeout(() => setFooter('Feed'), 1200);
      } catch {
        prompt('Copy this win share:', String(item.hype_text));
      }
    } finally {
      btnLatest.disabled = false;
    }
  };
  btns.appendChild(btnLatest);
  actions.appendChild(btns);

  root.appendChild(card('Challenge Feed', list));
  root.appendChild(card('Share', actions));
  setPanel(root);
}

async function showTournaments() {
  setFooter('Tournaments');
  const data = await apiFetch('/miniapp/api/tournaments');
  const items = Array.isArray(data?.tournaments) ? data.tournaments : [];

  const root = document.createElement('div');
  root.className = 'row';

  const list = document.createElement('div');
  list.className = 'list';

  if (!items.length) {
    list.appendChild(itemRow({ left: 'No tournaments', right: '—', meta: 'Come back later.' }));
  } else {
    items.forEach((t) => {
      const title = safeText(t.title || `Tournament #${t.id}`);
      const status = safeText(t.status || 'upcoming');
      const when = t.start_date ? safeText(t.start_date) : '—';
      const it = itemRow({
        left: title,
        right: status,
        meta: `Starts: ${when} · Max: ${safeText(t.max_participants || 16)} · Stake: ${safeText(t.entry_stake_amount || 0)}`,
      });
      it.onclick = async () => {
        try {
          setFooter('Loading tournament…');
          const state = await apiFetch(`/miniapp/api/tournaments/${t.id}`);
          const bracket = Array.isArray(state?.bracket) ? state.bracket : [];
          const participants = Array.isArray(state?.participants) ? state.participants : [];

          const view = document.createElement('div');
          view.className = 'row';
          view.appendChild(card('Tournament', (() => {
            const kvs = document.createElement('div');
            kvs.className = 'kvs';
            kvs.appendChild(kv('Title', title));
            kvs.appendChild(kv('Status', status));
            kvs.appendChild(kv('Participants', `${fmtNum(participants.length)} / ${fmtNum(t.max_participants || 16)}`));
            return kvs;
          })()));

          const btns = document.createElement('div');
          btns.className = 'btns';
          const btnJoin = document.createElement('button');
          btnJoin.className = 'btn primary';
          btnJoin.textContent = 'Join';
          btnJoin.onclick = async () => {
            btnJoin.disabled = true;
            try {
              const out = await apiFetch(`/miniapp/api/tournaments/${t.id}/join`, { method: 'POST', body: {} });
              if (out?.ok) {
                alert('Joined ✅');
              } else {
                alert(`Join failed: ${out?.error || 'failed'}`);
              }
            } finally {
              btnJoin.disabled = false;
            }
          };
          btns.appendChild(btnJoin);

          const btnBack = document.createElement('button');
          btnBack.className = 'btn';
          btnBack.textContent = 'Back';
          btnBack.onclick = () => showTournaments();
          btns.appendChild(btnBack);

          view.appendChild(card('Actions', btns));

          const bracketList = document.createElement('div');
          bracketList.className = 'list';
          if (!bracket.length) {
            bracketList.appendChild(itemRow({ left: 'No bracket yet', right: '—', meta: 'Tournament may not be started.' }));
          } else {
            bracket.forEach((m) => {
              bracketList.appendChild(
                itemRow({
                  left: `R${safeText(m.round)} · Slot ${safeText(m.slot)}`,
                  right: safeText(m.status || 'pending'),
                  meta: `A: ${safeText(m.player_a || '—')} vs B: ${safeText(m.player_b || '—')} · winner: ${safeText(m.winner_id || '—')}`,
                })
              );
            });
          }
          view.appendChild(card('Bracket', bracketList));

          setPanel(view);
          setFooter(title);
        } catch (err) {
          setFooter('Tournament load failed');
          setPanel(renderError('Tournament load failed', err));
        }
      };
      list.appendChild(it);
    });
  }

  root.appendChild(card('Lobby', list));
  setPanel(root);
}

async function showAmbassador() {
  setFooter('Ambassador');
  const data = await apiFetch('/miniapp/api/ambassadors/me');

  const root = document.createElement('div');
  root.className = 'row';

  const ambassador = data?.ambassador || null;
  const eligibility = data?.eligibility || null;
  const boosts = Array.isArray(data?.boosts) ? data.boosts : [];

  const kvs = document.createElement('div');
  kvs.className = 'kvs';
  kvs.appendChild(kv('Status', ambassador?.status ? safeText(ambassador.status) : 'not enrolled'));
  kvs.appendChild(kv('Level', ambassador?.level != null ? safeText(ambassador.level) : '—'));
  kvs.appendChild(kv('Score', ambassador?.score != null ? safeText(ambassador.score) : '—'));
  kvs.appendChild(kv('Eligible', eligibility?.eligible ? 'yes' : 'no'));
  if (eligibility?.reason) kvs.appendChild(kv('Note', safeText(eligibility.reason)));
  root.appendChild(card('Ambassador', kvs));

  const list = document.createElement('div');
  list.className = 'list';
  if (!boosts.length) {
    list.appendChild(itemRow({ left: 'No boosts', right: '—', meta: 'Admins can enable boosts for ambassadors.' }));
  } else {
    boosts.forEach((b) => {
      list.appendChild(
        itemRow({
          left: safeText(b.boost_type || 'boost'),
          right: `x${safeText(b.multiplier || 1)}`,
          meta: `from: ${safeText(b.starts_at || 'now')} · to: ${safeText(b.ends_at || 'open')}`,
        })
      );
    });
  }
  root.appendChild(card('Boosts', list));

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
    if (tab === 'feed') return await showFeed();
    if (tab === 'tournaments') return await showTournaments();
    if (tab === 'ambassador') return await showAmbassador();
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
