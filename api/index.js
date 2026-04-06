const app = require('../index');

module.exports = (req, res) => {
  // Express apps are callable handlers.
  return app(req, res);
};

