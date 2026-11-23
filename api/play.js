const g = require('../lib/engine');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') throw g.err(405, 'POST only');
    const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!tok) throw g.err(401, 'Sign in again');
    let dec;
    try { dec = await g.admin().auth().verifyIdToken(tok); } catch (e) { throw g.err(401, 'Sign in again'); }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    res.status(200).json(await g.act(dec, body));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error. Try again.' });
  }
};
