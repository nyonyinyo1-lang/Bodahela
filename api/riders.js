const g = require('../lib/engine');
/* Everyone's bets for the ride on screen and the next one. Cached 2 seconds at the edge so many players cost one read pair per 2 seconds. */
module.exports = async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=2');
    res.status(200).json(await g.publicRiders(Date.now()));
  } catch (e) {
    console.error(e);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Server error' });
  }
};
