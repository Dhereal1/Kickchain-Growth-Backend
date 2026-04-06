export function requireApiKey(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.split(" ")[1];

    if (!token || token !== process.env.INTEL_API_KEY) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized"
      });
    }

    next();
  } catch (err) {
    return res.status(401).json({
      ok: false,
      error: "invalid auth"
    });
  }
}

