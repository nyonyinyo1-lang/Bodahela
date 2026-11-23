const g = require('../lib/engine');
/* Chat: GET = last 50 messages (cached 2s at the edge), POST = send one (signed-in players only). */
module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store');
      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!tok) throw g.err(401, 'Sign in again');
      let dec;
      try { dec = await g.admin().auth().verifyIdToken(tok); } catch (e) { throw g.err(401, 'Sign in again'); }
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      return res.status(200).json(body.like ? await g.chatLike(dec, body.like) : await g.chatSend(dec, body.x));
    }
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=2');
    res.status(200).json(await g.chatList());
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Server error' });
  }
};
