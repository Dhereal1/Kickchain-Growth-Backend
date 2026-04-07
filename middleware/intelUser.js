async function resolveIntelUser({ pool, token }) {
  const t = String(token || '').trim();
  if (!t) return { user: null, isAdmin: false };

  const adminKey = String(process.env.INTEL_API_KEY || '').trim();
  if (adminKey && t === adminKey) {
    return { user: null, isAdmin: true };
  }

  const r = await pool.query('SELECT * FROM intel_users WHERE api_key = $1', [t]);
  const user = r.rows[0] || null;
  return { user, isAdmin: false };
}

function getBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.split(' ')[1] || '';
}

function requireIntelUser({ pool, allowAdmin = true } = {}) {
  return async (req, res, next) => {
    try {
      const token = getBearerToken(req);
      const { user, isAdmin } = await resolveIntelUser({ pool, token });

      if (isAdmin && allowAdmin) {
        req.intelAuth = { isAdmin: true, user: null, token };
        return next();
      }

      if (!user) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }

      req.intelAuth = { isAdmin: false, user, token };
      return next();
    } catch (err) {
      return res.status(401).json({ ok: false, error: 'invalid auth' });
    }
  };
}

module.exports = {
  requireIntelUser,
  getBearerToken,
  resolveIntelUser,
};

