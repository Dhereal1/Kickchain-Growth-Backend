async function getOrCreateWorkspace({ pool, ensureGrowthSchema, telegramChatId, name = null }) {
  await ensureGrowthSchema();

  const chatId = String(telegramChatId || '').trim();
  if (!chatId) throw new Error('telegram_chat_id is required');

  const r = await pool.query(
    `
      INSERT INTO intel_workspaces (telegram_chat_id, name)
      VALUES ($1, $2)
      ON CONFLICT (telegram_chat_id)
      DO UPDATE SET name = COALESCE(EXCLUDED.name, intel_workspaces.name)
      RETURNING id, telegram_chat_id, name, created_at
    `,
    [chatId, name ? String(name) : null]
  );

  return r.rows[0];
}

async function getWorkspaceConfig({ pool, ensureGrowthSchema, workspaceId }) {
  await ensureGrowthSchema();
  const id = Number(workspaceId);
  if (!Number.isFinite(id)) throw new Error('workspace_id is required');

  const r = await pool.query(
    `
      SELECT workspace_id, datasets, keywords, thresholds, updated_at
      FROM intel_workspace_configs
      WHERE workspace_id = $1
      LIMIT 1
    `,
    [id]
  );
  return r.rows[0] || null;
}

async function upsertWorkspaceConfig({
  pool,
  ensureGrowthSchema,
  workspaceId,
  datasets = null,
  keywords = null,
  thresholds = null,
}) {
  await ensureGrowthSchema();
  const id = Number(workspaceId);
  if (!Number.isFinite(id)) throw new Error('workspace_id is required');

  const thresholdsJson = thresholds && typeof thresholds === 'object' ? JSON.stringify(thresholds) : null;

  await pool.query(
    `
      INSERT INTO intel_workspace_configs (workspace_id, datasets, keywords, thresholds, updated_at)
      VALUES ($1,$2,$3,$4::jsonb,NOW())
      ON CONFLICT (workspace_id)
      DO UPDATE SET
        datasets = COALESCE(EXCLUDED.datasets, intel_workspace_configs.datasets),
        keywords = COALESCE(EXCLUDED.keywords, intel_workspace_configs.keywords),
        thresholds = COALESCE(EXCLUDED.thresholds, intel_workspace_configs.thresholds),
        updated_at = NOW()
    `,
    [id, Array.isArray(datasets) ? datasets.map(String) : null, Array.isArray(keywords) ? keywords.map(String) : null, thresholdsJson]
  );

  return { ok: true };
}

module.exports = {
  getOrCreateWorkspace,
  getWorkspaceConfig,
  upsertWorkspaceConfig,
};

