const { sendToUsers } = require('../../bot/notifyUsers');
const crypto = require('node:crypto');
const { computeReferralScore, computeChurnRisk } = require('./scoring');
const { decidePr6Nudge } = require('./rules');
const { upsertReferralBonus } = require('./referralBonus');

function truthy(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function num(v, fallback) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function clampInt(n, min, max, fallback) {
  const x = Math.trunc(num(n, fallback));
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

function getBotUsername() {
  return String(process.env.BOT_USERNAME || '').trim().replace(/^@/, '');
}

function referralLinkFor({ referralCode }) {
  const botUsername = getBotUsername();
  const code = String(referralCode || '').trim();
  if (!botUsername || !code) return '';
  return `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`;
}

function playLink() {
  const botUsername = getBotUsername();
  if (!botUsername) return '';
  return `https://t.me/${botUsername}`;
}

function stableBucketPct100({ telegramId, salt }) {
  const tid = String(telegramId || '').trim();
  const s = String(salt || '').trim();
  const h = crypto.createHash('sha256').update(`${s}:${tid}`).digest();
  // Use first 4 bytes as uint32, map to 0..99.
  const n = h.readUInt32BE(0);
  return n % 100;
}

function messageForNudge({ nudgeType, username, referralCode, bonus } = {}) {
  const handle = username ? `@${String(username).replace(/^@/, '')}` : 'there';
  const refLink = referralLinkFor({ referralCode }) || '(set `BOT_USERNAME` to show your referral link)';
  const playNow = playLink() || 'Open the bot and tap “Play Match”';
  const hasBonus = !!(bonus && Number(bonus.bonus_xp || 0) > 0 && Number(bonus.remaining_conversions || 0) > 0);

  if (nudgeType === 'churn_referral') {
    if (!hasBonus) {
      return (
        `Hey ${handle} — quick nudge to restart momentum.\n\n` +
        `Your invite link:\n${refLink}\n\n` +
        `⚔️ Play now:\n${playNow}`
      ).trim();
    }
    return (
      `Hey ${handle} — quick boost to restart momentum.\n\n` +
      `⏳ Limited-time referral boost: +${bonus?.bonus_xp || 0} XP per signup (up to ${bonus?.remaining_conversions || 0} invites), expires in ~${bonus?.ttl_hours || 48}h.\n\n` +
      `Your invite link:\n${refLink}\n\n` +
      `⚔️ Play now:\n${playNow}`
    ).trim();
  }

  if (nudgeType === 'referral_boost') {
    if (!hasBonus) {
      return (
        `Hey ${handle} — you’re a strong referrer.\n\n` +
        `Your invite link:\n${refLink}`
      ).trim();
    }
    return (
      `Hey ${handle} — you’re a strong referrer.\n\n` +
      `⏳ Limited-time referral boost: +${bonus?.bonus_xp || 0} XP per signup (up to ${bonus?.remaining_conversions || 0} invites), expires in ~${bonus?.ttl_hours || 48}h.\n\n` +
      `Your invite link:\n${refLink}`
    ).trim();
  }

  if (nudgeType === 'churn_play') {
    return (
      `Hey ${handle} — quick nudge to jump back in.\n\n` +
      `⚔️ Play now:\n${playNow}\n\n` +
      `Or invite a friend:\n${refLink}`
    ).trim();
  }

  return '';
}

function bucket10(n) {
  const x = Number(n) || 0;
  const b = Math.floor(x / 10);
  return Math.max(0, Math.min(9, b));
}

function computeHistogram10(values) {
  const buckets = new Array(10).fill(0);
  let sum = 0;
  let count = 0;
  let min = null;
  let max = null;

  for (const v of values) {
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    buckets[bucket10(x)] += 1;
    sum += x;
    count += 1;
    if (min == null || x < min) min = x;
    if (max == null || x > max) max = x;
  }

  return {
    buckets_10: buckets,
    avg: count ? sum / count : 0,
    min: min == null ? 0 : min,
    max: max == null ? 0 : max,
    n: count,
  };
}

function computePercentiles(values, ps) {
  const list = [];
  for (const v of values) {
    const x = Number(v);
    if (Number.isFinite(x)) list.push(x);
  }
  list.sort((a, b) => a - b);
  if (!list.length) return {};

  const out = {};
  const probs = Array.isArray(ps) && ps.length ? ps : [0.5, 0.9, 0.99];
  for (const p of probs) {
    const pp = Number(p);
    if (!Number.isFinite(pp) || pp < 0 || pp > 1) continue;
    const idx = Math.min(list.length - 1, Math.max(0, Math.floor(pp * (list.length - 1))));
    out[`p${Math.round(pp * 100)}`] = list[idx];
  }
  return out;
}

function formatPr6TeamOutput(out) {
  const lines = [];
  if (!out || typeof out !== 'object') return '';

  lines.push('🧪 PR6 Referral Optimizer');
  lines.push(`Day: ${out.day || '—'}  Dry-run: ${out.dry_run ? 'yes' : 'no'}  Canary: ${out.canary_percent ?? '—'}%`);
  lines.push('');

  if (out.distributions?.referral_score) {
    const p = out.distributions.referral_score.percentiles || {};
    lines.push(`Referral score p50/p90/p99: ${p.p50 ?? '—'} / ${p.p90 ?? '—'} / ${p.p99 ?? '—'}`);
  }
  if (out.distributions?.churn_risk) {
    const p = out.distributions.churn_risk.percentiles || {};
    lines.push(`Churn risk p50/p90/p99: ${p.p50 ?? '—'} / ${p.p90 ?? '—'} / ${p.p99 ?? '—'}`);
  }
  if (out.day_over_day?.referral_score?.delta_percentiles) {
    const d = out.day_over_day.referral_score.delta_percentiles;
    lines.push(`DoD Δ referral p50/p90/p99: ${d.p50 ?? '—'} / ${d.p90 ?? '—'} / ${d.p99 ?? '—'}`);
  }
  if (out.day_over_day?.churn_risk?.delta_percentiles) {
    const d = out.day_over_day.churn_risk.delta_percentiles;
    lines.push(`DoD Δ churn p50/p90/p99: ${d.p50 ?? '—'} / ${d.p90 ?? '—'} / ${d.p99 ?? '—'}`);
  }

  const proj = out.projections || {};
  if (proj.nudges_selected != null) lines.push(`Projected nudges: ${proj.nudges_selected}`);
  if (proj.nudges_by_type) {
    const parts = Object.entries(proj.nudges_by_type)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([k, v]) => `${k}:${v}`);
    if (parts.length) lines.push(`By type: ${parts.join('  ')}`);
  }
  if (proj.allocated_bonus_xp != null) lines.push(`Allocated bonus XP: ${proj.allocated_bonus_xp}`);

  if (out.caps) {
    const rate = typeof out.caps.cap_hit_rate === 'number' ? out.caps.cap_hit_rate : null;
    if (rate != null) lines.push(`Cap hit rate (bonus cap): ${(rate * 100).toFixed(1)}%`);
    const nudgeRate = typeof out.caps.nudge_cap_hit_rate_7d === 'number' ? out.caps.nudge_cap_hit_rate_7d : null;
    if (nudgeRate != null) lines.push(`Cap hit rate (7d nudge cap): ${(nudgeRate * 100).toFixed(1)}%`);
  }

  if (out.skipped) {
    const s = out.skipped;
    lines.push(`Skipped: canary=${s.canary ?? 0} cooldown=${s.cooldown ?? 0} cap7d=${s.nudge_cap_7d ?? 0}`);
  }

  if (out.selected_signals?.referrals_total?.percentiles) {
    const p = out.selected_signals.referrals_total.percentiles;
    lines.push(`Selected referrals_total p50/p90/p99: ${p.p50 ?? '—'} / ${p.p90 ?? '—'} / ${p.p99 ?? '—'}`);
  }
  if (out.selected_signals?.wins_30d?.percentiles) {
    const p = out.selected_signals.wins_30d.percentiles;
    lines.push(`Selected wins_30d p50/p90/p99: ${p.p50 ?? '—'} / ${p.p90 ?? '—'} / ${p.p99 ?? '—'}`);
  }
  if (out.whale_concentration?.referrals_total_top10_share != null) {
    lines.push(`Whale share (selected referrals_total, top10): ${(out.whale_concentration.referrals_total_top10_share * 100).toFixed(1)}%`);
  }

  return lines.join('\n');
}

function computeTopKShareDesc(values, k) {
  const list = [];
  for (const v of values) {
    const x = Number(v);
    if (Number.isFinite(x) && x > 0) list.push(x);
  }
  if (!list.length) return 0;
  list.sort((a, b) => b - a);
  const kk = Math.max(1, Math.min(list.length, Math.trunc(Number(k) || 0) || 1));
  const top = list.slice(0, kk).reduce((a, b) => a + b, 0);
  const total = list.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  return top / total;
}

function isoDayMinus1(day) {
  const s = String(day || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(`${s}T00:00:00.000Z`);
  const prev = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  return prev.toISOString().slice(0, 10);
}

async function getPrevDayDistributions({ pool, day } = {}) {
  const prevDay = isoDayMinus1(day);
  if (!prevDay) return null;

  const r = await pool.query(
    `
      SELECT
        $1::date AS day,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY referral_score)::float AS referral_p50,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY referral_score)::float AS referral_p90,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY referral_score)::float AS referral_p99,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY churn_risk)::float AS churn_p50,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY churn_risk)::float AS churn_p90,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY churn_risk)::float AS churn_p99,
        COUNT(*)::int AS n
      FROM pr6_user_scores_daily
      WHERE day = $1
    `,
    [prevDay]
  );
  const row = r.rows[0] || null;
  if (!row || !row.n) return null;

  return {
    day: prevDay,
    n: Number(row.n) || 0,
    referral_score: { percentiles: { p50: row.referral_p50, p90: row.referral_p90, p99: row.referral_p99 } },
    churn_risk: { percentiles: { p50: row.churn_p50, p90: row.churn_p90, p99: row.churn_p99 } },
  };
}

function round1(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

function computePercentileDeltas(cur, prev) {
  const c = cur?.percentiles || {};
  const p = prev?.percentiles || {};
  const d = {
    p50: c.p50 == null || p.p50 == null ? null : round1(Number(c.p50) - Number(p.p50)),
    p90: c.p90 == null || p.p90 == null ? null : round1(Number(c.p90) - Number(p.p90)),
    p99: c.p99 == null || p.p99 == null ? null : round1(Number(c.p99) - Number(p.p99)),
  };
  return d;
}

async function bulkUpsertScores({ pool, day, rows } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { ok: true, upserted: 0, batches: 0, elapsed_ms: 0 };

  const started = Date.now();
  let upserted = 0;
  let batches = 0;

  const chunkSize = 500;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const values = [];
    const params = [];
    let p = 1;

    for (const r of chunk) {
      params.push(day, Number(r.telegram_id), Number(r.referral_score), Number(r.churn_risk));
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, NOW())`);
    }

    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await pool.query(
      `
        INSERT INTO pr6_user_scores_daily (day, telegram_id, referral_score, churn_risk, computed_at)
        VALUES ${values.join(',')}
        ON CONFLICT (day, telegram_id)
        DO UPDATE SET
          referral_score = EXCLUDED.referral_score,
          churn_risk = EXCLUDED.churn_risk,
          computed_at = NOW()
      `,
      params
    );
    const dt = Date.now() - t0;
    if (dt >= 250) {
      console.info('pr6 slow score upsert batch', { ms: dt, batch_size: chunk.length });
    }

    upserted += chunk.length;
    batches += 1;
  }

  return { ok: true, upserted, batches, elapsed_ms: Date.now() - started };
}

async function runPr6ReferralOptimizer({ pool, ensureGrowthSchema, dryRun } = {}) {
  if (!pool) throw new Error('pool is required');
  if (!ensureGrowthSchema) throw new Error('ensureGrowthSchema is required');

  const isDryRun = truthy(dryRun);
  await ensureGrowthSchema();

  const dayRes = await pool.query(`SELECT (NOW() AT TIME ZONE 'UTC')::date AS day`);
  const day = String(dayRes.rows[0]?.day || '').slice(0, 10);
  if (!day) throw new Error('failed_to_resolve_day');

  const maxNudges = clampInt(process.env.PR6_MAX_NUDGES_PER_RUN, 0, 500, 50);
  const cooldownHours = Math.max(0, num(process.env.PR6_NUDGE_COOLDOWN_HOURS, 24));
  const maxNudgesPerUser7d = clampInt(process.env.PR6_MAX_NUDGES_PER_USER_7D, 0, 50, 3);
  const bonusXp = clampInt(process.env.PR6_BONUS_XP, 0, 10000, 80);
  const bonusConversions = clampInt(process.env.PR6_BONUS_CONVERSIONS, 0, 100, 3);
  const bonusTtlHours = Math.max(1, num(process.env.PR6_BONUS_TTL_HOURS, 48));
  const maxBonusXpPerUser30d = clampInt(process.env.PR6_MAX_BONUS_XP_PER_USER_30D, 0, 100000, 500);
  const referralThreshold = clampInt(process.env.PR6_REFERRAL_SCORE_THRESHOLD, 0, 100, 75);
  const churnThreshold = clampInt(process.env.PR6_CHURN_RISK_THRESHOLD, 0, 100, 70);
  const canaryPercent = clampInt(process.env.PR6_CANARY_PERCENT, 0, 100, 100);
  const canarySalt = String(process.env.PR6_CANARY_SALT || 'pr6').trim() || 'pr6';

  const usersRes = await pool.query(
    `
      WITH referral_counts AS (
        SELECT referred_by AS referral_code, COUNT(*)::int AS referrals_total
        FROM users
        WHERE referred_by IS NOT NULL
        GROUP BY referred_by
      ),
      wins_30d AS (
        SELECT winner_id AS telegram_id, COUNT(*)::int AS wins_30d
        FROM matches
        WHERE winner_id IS NOT NULL
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY winner_id
      ),
      pr6_caps AS (
        SELECT
          telegram_id,
          COUNT(*) FILTER (
            WHERE created_at >= NOW() - INTERVAL '7 days'
              AND status IN ('queued', 'sent')
          )::int AS nudges_7d,
          SUM(
            CASE
              WHEN created_at >= NOW() - INTERVAL '30 days'
                AND status IN ('queued', 'sent')
              THEN (COALESCE(bonus_xp, 0) * COALESCE(bonus_conversions, 0))
              ELSE 0
            END
          )::int AS bonus_xp_30d
        FROM pr6_nudges
        GROUP BY telegram_id
      )
      SELECT
        u.telegram_id,
        u.username,
        u.referral_code,
        COALESCE(rc.referrals_total, 0)::int AS referrals_total,
        COALESCE(w.wins_30d, 0)::int AS wins_30d,
        COALESCE(u.win_streak, 0)::int AS win_streak,
        COALESCE(u.daily_check_streak, 0)::int AS daily_streak,
        GREATEST(
          COALESCE(u.last_daily_check_at, 'epoch'::timestamp),
          COALESCE(u.last_win_at, 'epoch'::timestamp),
          COALESCE(u.last_loss_at, 'epoch'::timestamp),
          COALESCE(u.created_at, 'epoch'::timestamp)
        ) AS last_active_at,
        u.last_pr6_nudge_at,
        COALESCE(p6.nudges_7d, 0)::int AS pr6_nudges_7d,
        COALESCE(p6.bonus_xp_30d, 0)::int AS pr6_bonus_xp_30d
      FROM users u
      LEFT JOIN referral_counts rc ON rc.referral_code = u.referral_code
      LEFT JOIN wins_30d w ON w.telegram_id = u.telegram_id
      LEFT JOIN pr6_caps p6 ON p6.telegram_id = u.telegram_id
      WHERE u.telegram_id IS NOT NULL
    `
  );

  const nowMs = Date.now();
  const scores = [];
  const candidates = [];
  let skippedCooldown = 0;
  let skippedNudgeCap = 0;
  let skippedCanary = 0;
  let bonusCappedCount = 0;

  for (const u of usersRes.rows || []) {
    const telegramId = Number(u.telegram_id);
    if (!Number.isFinite(telegramId) || !telegramId) continue;

    const referralScore = computeReferralScore({
      referralsTotal: u.referrals_total,
      winsLast30d: u.wins_30d,
      winStreak: u.win_streak,
      dailyStreak: u.daily_streak,
    });
    const lastActiveMs = u.last_active_at ? new Date(u.last_active_at).getTime() : nowMs;
    const churnRisk = computeChurnRisk({ lastActiveAtMs: lastActiveMs, nowMs });

    scores.push({
      telegram_id: telegramId,
      referral_score: referralScore,
      churn_risk: churnRisk,
    });

    const isCandidate = referralScore >= referralThreshold || churnRisk >= churnThreshold;
    if (!isCandidate) continue;

    if (canaryPercent < 100) {
      const bucket = stableBucketPct100({ telegramId, salt: canarySalt });
      if (bucket >= canaryPercent) {
        skippedCanary += 1;
        continue;
      }
    }

    const lastNudgeMs = u.last_pr6_nudge_at ? new Date(u.last_pr6_nudge_at).getTime() : 0;
    const inCooldown = cooldownHours > 0 && lastNudgeMs && nowMs - lastNudgeMs < cooldownHours * 60 * 60 * 1000;
    if (inCooldown) {
      skippedCooldown += 1;
      continue;
    }

    const decision = decidePr6Nudge({ referralScore, churnRisk });
    if (!decision) continue;

    if (maxNudgesPerUser7d > 0 && Number(u.pr6_nudges_7d || 0) >= maxNudgesPerUser7d) {
      skippedNudgeCap += 1;
      continue;
    }

    let grantBonus = !!decision.grant_bonus;
    let bonusCapped = false;
    if (grantBonus && maxBonusXpPerUser30d > 0) {
      const already = Math.max(0, Number(u.pr6_bonus_xp_30d || 0) || 0);
      const potential = Math.max(0, bonusXp) * Math.max(0, bonusConversions);
      if (already + potential > maxBonusXpPerUser30d) {
        grantBonus = false;
        bonusCapped = true;
      }
    }
    if (bonusCapped) bonusCappedCount += 1;

    candidates.push({
      telegram_id: telegramId,
      username: u.username || null,
      referral_code: u.referral_code || null,
      referrals_total: Number(u.referrals_total || 0) || 0,
      wins_30d: Number(u.wins_30d || 0) || 0,
      referral_score: referralScore,
      churn_risk: churnRisk,
      nudge_type: decision.nudge_type,
      grant_bonus: grantBonus,
      bonus_capped: bonusCapped,
      pr6_nudges_7d: Number(u.pr6_nudges_7d || 0) || 0,
      pr6_bonus_xp_30d: Number(u.pr6_bonus_xp_30d || 0) || 0,
    });
  }

  // Persist scores daily (always, even dry run).
  const scoreWrite = await bulkUpsertScores({ pool, day, rows: scores });

  const referralHist = computeHistogram10(scores.map((x) => x.referral_score));
  const churnHist = computeHistogram10(scores.map((x) => x.churn_risk));
  referralHist.percentiles = computePercentiles(scores.map((x) => x.referral_score), [0.5, 0.9, 0.99]);
  churnHist.percentiles = computePercentiles(scores.map((x) => x.churn_risk), [0.5, 0.9, 0.99]);

  const prev = await getPrevDayDistributions({ pool, day });
  const dayOverDay = prev
    ? {
        prev_day: prev.day,
        referral_score: { delta_percentiles: computePercentileDeltas(referralHist, prev.referral_score) },
        churn_risk: { delta_percentiles: computePercentileDeltas(churnHist, prev.churn_risk) },
      }
    : null;

  // Prioritize candidates by rule order, then by strongest relevant score.
  const prio = { churn_referral: 1, referral_boost: 2, churn_play: 3 };
  candidates.sort((a, b) => {
    const pa = prio[a.nudge_type] || 99;
    const pb = prio[b.nudge_type] || 99;
    if (pa !== pb) return pa - pb;
    const sa =
      a.nudge_type === 'referral_boost'
        ? a.referral_score
        : (a.churn_risk * 1000 + a.referral_score);
    const sb =
      b.nudge_type === 'referral_boost'
        ? b.referral_score
        : (b.churn_risk * 1000 + b.referral_score);
    return sb - sa;
  });

  const selected = candidates.slice(0, Math.max(0, maxNudges));
  const byType = selected.reduce((acc, x) => {
    const k = String(x.nudge_type || 'unknown');
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const allocatedBonusUsers = selected.filter((x) => x.grant_bonus).length;
  const allocatedBonusXp = allocatedBonusUsers * Math.max(0, bonusXp) * Math.max(0, bonusConversions);
  const allocatedBonusConversions = allocatedBonusUsers * Math.max(0, bonusConversions);

  const selectedRefTotals = selected.map((x) => x.referrals_total);
  const selectedWins30d = selected.map((x) => x.wins_30d);
  const selectedSignals = {
    referrals_total: {
      percentiles: computePercentiles(selectedRefTotals, [0.5, 0.9, 0.99]),
      n: selectedRefTotals.length,
    },
    wins_30d: {
      percentiles: computePercentiles(selectedWins30d, [0.5, 0.9, 0.99]),
      n: selectedWins30d.length,
    },
  };
  const whaleConcentration = {
    referrals_total_top10_share: computeTopKShareDesc(selectedRefTotals, 10),
  };

  const preview = selected.map((c) => ({
    telegram_id: c.telegram_id,
    nudge_type: c.nudge_type,
    referral_score: c.referral_score,
    churn_risk: c.churn_risk,
    grant_bonus: !!c.grant_bonus,
    bonus_capped: !!c.bonus_capped,
    pr6_nudges_7d: Number(c.pr6_nudges_7d || 0) || 0,
    pr6_bonus_xp_30d: Number(c.pr6_bonus_xp_30d || 0) || 0,
  }));

  if (isDryRun) {
    const bonusCappedSelected = selected.filter((x) => x.bonus_capped).length;
    const attemptedCandidates = candidates.length + skippedNudgeCap;
    return {
      ok: true,
      dry_run: true,
      day,
      users_scanned: (usersRes.rows || []).length,
      scores_written: scoreWrite.upserted,
      distributions: {
        referral_score: referralHist,
        churn_risk: churnHist,
      },
      previous_day: prev,
      day_over_day: dayOverDay,
      canary_percent: canaryPercent,
      skipped: {
        canary: skippedCanary,
        cooldown: skippedCooldown,
        nudge_cap_7d: skippedNudgeCap,
      },
      caps: {
        bonus_capped_candidates: bonusCappedCount,
        cap_hit_rate: selected.length ? bonusCappedSelected / selected.length : 0,
        nudge_cap_hit_rate_7d: attemptedCandidates ? skippedNudgeCap / attemptedCandidates : 0,
      },
      selected_signals: selectedSignals,
      whale_concentration: whaleConcentration,
      projections: {
        nudges_selected: selected.length,
        nudges_by_type: byType,
        allocated_bonus_users: allocatedBonusUsers,
        allocated_bonus_conversions: allocatedBonusConversions,
        allocated_bonus_xp: allocatedBonusXp,
      },
      would_nudge: preview,
    };
  }

  let sent = 0;
  let failed = 0;
  let bonusesGranted = 0;

  for (const c of selected) {
    const tid = Number(c.telegram_id);
    const nudgeType = String(c.nudge_type || '').trim();
    if (!nudgeType) continue;

    let bonus = null;
    if (c.grant_bonus) {
      const granted = await upsertReferralBonus({
        pool,
        telegramId: tid,
        bonusXp,
        remainingConversions: bonusConversions,
        ttlHours: bonusTtlHours,
      });
      if (granted?.granted) bonusesGranted += 1;
      bonus = { bonus_xp: bonusXp, remaining_conversions: bonusConversions, ttl_hours: bonusTtlHours };
    }

    const text = messageForNudge({
      nudgeType,
      username: c.username,
      referralCode: c.referral_code,
      bonus,
    });
    if (!text) continue;

    try {
      const ins = await pool.query(
        `
          INSERT INTO pr6_nudges (
            day, telegram_id, nudge_type, bonus_xp, bonus_conversions, bonus_capped, status, error, created_at, sent_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'queued', NULL, NOW(), NULL)
          ON CONFLICT (day, telegram_id, nudge_type) DO NOTHING
          RETURNING id
        `,
        [
          day,
          tid,
          nudgeType,
          c.grant_bonus ? bonusXp : 0,
          c.grant_bonus ? bonusConversions : 0,
          c.bonus_capped ? true : false,
        ]
      );
      if (!ins.rowCount) continue; // Already sent/queued today for this type.

      const r = await sendToUsers([tid], text, { disable_web_page_preview: true });
      const ok = (r?.sent || 0) >= 1;
      if (!ok) throw new Error('telegram_send_failed');

      await pool.query(
        `UPDATE pr6_nudges SET status='sent', sent_at=NOW(), error=NULL WHERE day=$1 AND telegram_id=$2 AND nudge_type=$3`,
        [day, tid, nudgeType]
      );
      await pool.query(`UPDATE users SET last_pr6_nudge_at = NOW() WHERE telegram_id = $1`, [tid]);
      sent += 1;
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 2000);
      failed += 1;
      await pool.query(
        `UPDATE pr6_nudges SET status='failed', error=$4 WHERE day=$1 AND telegram_id=$2 AND nudge_type=$3`,
        [day, tid, nudgeType, msg]
      );
    }
  }

  return {
    ok: true,
    dry_run: false,
    day,
    users_scanned: (usersRes.rows || []).length,
    scores_written: scoreWrite.upserted,
    distributions: {
      referral_score: referralHist,
      churn_risk: churnHist,
    },
    previous_day: prev,
    day_over_day: dayOverDay,
    canary_percent: canaryPercent,
    nudges_selected: selected.length,
    sent,
    failed,
    bonuses_granted: bonusesGranted,
    caps: {
      bonus_capped_selected: selected.filter((x) => x.bonus_capped).length,
      cap_hit_rate: sent ? (selected.filter((x) => x.bonus_capped).length / sent) : 0,
    },
    selected_signals: selectedSignals,
    whale_concentration: whaleConcentration,
    projections: {
      nudges_by_type: byType,
      allocated_bonus_users: allocatedBonusUsers,
      allocated_bonus_conversions: allocatedBonusConversions,
      allocated_bonus_xp: allocatedBonusXp,
    },
  };
}

module.exports = {
  runPr6ReferralOptimizer,
  _internals: {
    messageForNudge,
    referralLinkFor,
    playLink,
    bulkUpsertScores,
    computeHistogram10,
    computePercentiles,
    computeTopKShareDesc,
    formatPr6TeamOutput,
    getPrevDayDistributions,
  },
};
