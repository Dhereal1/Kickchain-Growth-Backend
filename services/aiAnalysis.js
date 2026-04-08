const crypto = require('crypto');

function normalizeMessageText(m) {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (typeof m === 'object') {
    if (typeof m.text === 'string') return m.text;
    if (typeof m.message === 'string') return m.message;
    if (typeof m.content === 'string') return m.content;
  }
  return String(m);
}

function takeSampleMessages(messages, max = 10) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const t = normalizeMessageText(m).trim();
    if (!t) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function computeMessagesHash(messages) {
  const sample = takeSampleMessages(messages, 10)
    .map((t) => t.toLowerCase().replace(/\s+/g, ' ').trim())
    .join('\n');
  return sha256(sample);
}

function buildSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      quality_score: { type: 'number', minimum: 0, maximum: 10 },
      intent_detected: { type: 'boolean' },
      category: { type: 'string', enum: ['high_value', 'medium', 'low'] },
      summary: { type: 'string' },
      recommended_action: { type: 'string', enum: ['join', 'monitor', 'ignore'] },
    },
    required: ['quality_score', 'intent_detected', 'category', 'summary', 'recommended_action'],
  };
}

function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // try to salvage first JSON object
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = text.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function analyzeCommunity({
  communityName,
  messages,
  model = 'gpt-4o-mini',
  apiKey = process.env.OPENAI_API_KEY,
  timeoutMs = Number(process.env.AI_ANALYSIS_TIMEOUT_MS || 12_000),
}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    const err = new Error('OPENAI_API_KEY missing');
    err.code = 'OPENAI_KEY_MISSING';
    throw err;
  }

  const sample = takeSampleMessages(messages, 10);
  if (!sample.length) {
    return {
      quality_score: 0,
      intent_detected: false,
      category: 'low',
      summary: 'No usable messages provided for analysis.',
      recommended_action: 'ignore',
      _meta: { sampled: 0, model },
    };
  }

  const system =
    "You are analyzing a Telegram/Discord community for growth opportunities. " +
    "Only use the provided messages. Do not invent facts. " +
    "Return a single JSON object that matches the provided schema.";

  const user = [
    `Community: ${communityName || 'unknown'}`,
    '',
    'Sample messages:',
    ...sample.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, ' ').trim()}`),
    '',
    'Determine:',
    '1) Is this community active and real?',
    '2) Are users expressing intent (buying, asking, needing)?',
    '3) Is this community relevant for a crypto/gaming product?',
    '4) Should a growth team join, ignore, or monitor this group?',
  ].join('\n');

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));

  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: system }] },
          { role: 'user', content: [{ type: 'input_text', text: user }] },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'community_analysis',
            strict: true,
            schema: buildSchema(),
          },
        },
      }),
      signal: controller.signal,
    });

    const json = await r.json().catch(() => null);
    if (!r.ok) {
      const details = json?.error?.message || json?.message || `HTTP ${r.status}`;
      const err = new Error(`OpenAI API error: ${details}`);
      err.status = r.status;
      err.data = json;
      throw err;
    }

    const outputText = json?.output_text || '';
    const parsed = extractJson(outputText);
    if (!parsed) {
      const err = new Error('Failed to parse AI JSON output');
      err.data = { output_text: outputText };
      throw err;
    }

    return {
      ...parsed,
      _meta: { sampled: sample.length, model },
    };
  } finally {
    clearTimeout(t);
  }
}

async function getCachedCommunityAnalysis({
  pool,
  ensureGrowthSchema,
  userId,
  workspaceId,
  platform,
  communityName,
  messagesHash,
  ttlHours = Number(process.env.AI_ANALYSIS_TTL_HOURS || 24),
}) {
  await ensureGrowthSchema();

  const wsId = workspaceId === null || workspaceId === undefined ? null : Number(workspaceId);
  const uId = wsId ? null : (userId === null || userId === undefined ? null : Number(userId));

  const r = await pool.query(
    `
      SELECT
        id,
        user_id,
        workspace_id,
        platform,
        community_name,
        analysis,
        messages_hash,
        updated_at
      FROM community_ai_analyses
      WHERE platform = $1
        AND community_name = $2
        AND (($3::int IS NULL OR workspace_id = $3) AND ($4::int IS NULL OR user_id = $4))
      LIMIT 1
    `,
    [platform, communityName, wsId, uId]
  );

  const row = r.rows[0] || null;
  if (!row) return null;

  const ageOk =
    row.updated_at &&
    Number(ttlHours) > 0 &&
    new Date(row.updated_at).getTime() >= Date.now() - Number(ttlHours) * 60 * 60 * 1000;
  const hashOk = !messagesHash || row.messages_hash === messagesHash;

  if (ageOk && hashOk) return row;
  return null;
}

async function upsertCommunityAnalysis({
  pool,
  ensureGrowthSchema,
  userId,
  workspaceId,
  platform,
  communityName,
  messagesHash,
  model,
  analysis,
}) {
  await ensureGrowthSchema();

  const a = analysis && typeof analysis === 'object' ? analysis : {};
  const qualityScore = Number(a.quality_score);
  const intentDetected = typeof a.intent_detected === 'boolean' ? a.intent_detected : null;
  const category = a.category ? String(a.category) : null;
  const recommendedAction = a.recommended_action ? String(a.recommended_action) : null;
  const summary = a.summary ? String(a.summary) : null;

  const wsId = workspaceId === null || workspaceId === undefined ? null : Number(workspaceId);
  const id = wsId ? null : (userId == null ? null : Number(userId));
  const params = [
    id,
    wsId,
    platform,
    communityName,
    model,
    messagesHash || null,
    Number.isFinite(qualityScore) ? qualityScore : null,
    intentDetected,
    category,
    recommendedAction,
    summary,
    JSON.stringify(analysis || {}),
  ];

  if (wsId != null) {
    await pool.query(
      `
        INSERT INTO community_ai_analyses (
          user_id,
          workspace_id,
          platform,
          community_name,
          model,
          messages_hash,
          quality_score,
          intent_detected,
          category,
          recommended_action,
          summary,
          analysis,
          updated_at
        )
        VALUES (NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())
        ON CONFLICT (workspace_id, platform, community_name) WHERE workspace_id IS NOT NULL
        DO UPDATE SET
          model = EXCLUDED.model,
          messages_hash = EXCLUDED.messages_hash,
          quality_score = EXCLUDED.quality_score,
          intent_detected = EXCLUDED.intent_detected,
          category = EXCLUDED.category,
          recommended_action = EXCLUDED.recommended_action,
          summary = EXCLUDED.summary,
          analysis = EXCLUDED.analysis,
          updated_at = NOW()
      `,
      params
    );
    return;
  }

  if (id == null) {
    await pool.query(
      `
        INSERT INTO community_ai_analyses (
          user_id,
          workspace_id,
          platform,
          community_name,
          model,
          messages_hash,
          quality_score,
          intent_detected,
          category,
          recommended_action,
          summary,
          analysis,
          updated_at
        )
        VALUES (NULL, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())
        ON CONFLICT (platform, community_name) WHERE user_id IS NULL AND workspace_id IS NULL
        DO UPDATE SET
          model = EXCLUDED.model,
          messages_hash = EXCLUDED.messages_hash,
          quality_score = EXCLUDED.quality_score,
          intent_detected = EXCLUDED.intent_detected,
          category = EXCLUDED.category,
          recommended_action = EXCLUDED.recommended_action,
          summary = EXCLUDED.summary,
          analysis = EXCLUDED.analysis,
          updated_at = NOW()
      `,
      params
    );
    return;
  }

  await pool.query(
    `
      INSERT INTO community_ai_analyses (
        user_id,
        workspace_id,
        platform,
        community_name,
        model,
        messages_hash,
        quality_score,
        intent_detected,
        category,
        recommended_action,
        summary,
        analysis,
        updated_at
      )
      VALUES ($1, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())
      ON CONFLICT (user_id, platform, community_name) WHERE user_id IS NOT NULL AND workspace_id IS NULL
      DO UPDATE SET
        model = EXCLUDED.model,
        messages_hash = EXCLUDED.messages_hash,
        quality_score = EXCLUDED.quality_score,
        intent_detected = EXCLUDED.intent_detected,
        category = EXCLUDED.category,
        recommended_action = EXCLUDED.recommended_action,
        summary = EXCLUDED.summary,
        analysis = EXCLUDED.analysis,
        updated_at = NOW()
    `,
    params
  );
}

module.exports = {
  analyzeCommunity,
  takeSampleMessages,
  computeMessagesHash,
  getCachedCommunityAnalysis,
  upsertCommunityAnalysis,
};
