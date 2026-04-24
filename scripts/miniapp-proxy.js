const http = require('http');

function isAllowedPath(url) {
  const u = String(url || '');
  return u === '/miniapp' || u.startsWith('/miniapp/') || u.startsWith('/miniapp/api/');
}

function stripHopByHopHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k || '').toLowerCase();
    if (
      key === 'connection' ||
      key === 'keep-alive' ||
      key === 'proxy-authenticate' ||
      key === 'proxy-authorization' ||
      key === 'te' ||
      key === 'trailer' ||
      key === 'transfer-encoding' ||
      key === 'upgrade'
    ) {
      // skip
      // eslint-disable-next-line no-continue
      continue;
    }
    out[k] = v;
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  return Buffer.concat(chunks);
}

async function handler(req, res) {
  try {
    if (!isAllowedPath(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }

    const targetPort = Number(process.env.MINIAPP_TARGET_PORT || 3000) || 3000;
    const target = `http://127.0.0.1:${targetPort}${req.url}`;
    const method = String(req.method || 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);

    const r = await fetch(target, {
      method,
      headers: stripHopByHopHeaders(req.headers),
      body,
    });

    const headers = {};
    for (const [k, v] of r.headers.entries()) headers[k] = v;
    res.writeHead(r.status, stripHopByHopHeaders(headers));
    if (r.body) {
      // Stream through
      r.body.pipeTo(
        new WritableStream({
          write(chunk) {
            res.write(Buffer.from(chunk));
          },
          close() {
            res.end();
          },
          abort() {
            try {
              res.end();
            } catch {
              // ignore
            }
          },
        })
      );
      return;
    }
    const text = await r.text();
    res.end(text);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'proxy_failed', message: err?.message || String(err) }));
  }
}

function main() {
  const port = Number(process.env.MINIAPP_PROXY_PORT || 3111) || 3111;
  const server = http.createServer((req, res) => {
    handler(req, res);
  });
  server.listen(port, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`Miniapp proxy listening on http://127.0.0.1:${port} (forwarding to :${Number(process.env.MINIAPP_TARGET_PORT || 3000) || 3000})`);
    // eslint-disable-next-line no-console
    console.log('Allowed paths: /miniapp/* and /miniapp/api/*');
  });
}

main();

