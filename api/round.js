const g = require('../lib/game');
/* Public round info. Cached for 1 second at the edge so many players cost one function call per second. */
module.exports = (req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=1');
    res.status(200).json(g.publicRound(Date.now()));
  } catch (e) {
    console.error(e);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Server error' });
  }
};
