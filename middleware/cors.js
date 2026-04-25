function normalizeConfiguredOrigins(value) {
  const raw = String(value ?? '*').trim();
  if (!raw) return '*';
  return raw;
}

function parseAllowedOrigins(configured) {
  return String(configured || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function createCorsMiddleware({ corsOrigin } = {}) {
  const configured = normalizeConfiguredOrigins(corsOrigin ?? process.env.CORS_ORIGIN ?? '*');
  const allowAnyOrigin = configured === '*';
  const allowed = allowAnyOrigin ? [] : parseAllowedOrigins(configured);

  return function corsMiddleware(req, res, next) {
    const requestOrigin = req.headers?.origin;

    let allowOrigin = '*';
    let allowCredentials = false;
    let varyOrigin = false;

    if (allowAnyOrigin) {
      allowOrigin = '*';
      allowCredentials = false;
      varyOrigin = false;
    } else if (requestOrigin) {
      if (allowed.includes(requestOrigin)) {
        allowOrigin = requestOrigin;
        allowCredentials = true;
        varyOrigin = true;
      } else {
        allowOrigin = 'null';
        allowCredentials = false;
        varyOrigin = true;
      }
    } else {
      allowOrigin = allowed[0] || 'null';
      allowCredentials = true;
      varyOrigin = false;
    }

    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    if (varyOrigin) res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers?.['access-control-request-headers'] || 'Content-Type, Authorization'
    );
    if (allowCredentials) res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    return next();
  };
}

module.exports = {
  createCorsMiddleware,
};

