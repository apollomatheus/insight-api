'use strict';

function Common(options) {
  this.log = options.log;
}

Common.prototype.notReady = function (err, res, p) {
  res.status(503).send('Server not yet ready. Sync Percentage:' + p);
};

Common.prototype.handleErrors = function (err, res) {
  if (err) {
    if (err.code)  {
      res.status(400).send(err.message + '. Code:' + err.code);
    } else {
      this.log.error(err.stack);
      res.status(503).send(err.message);
    }
  } else {
    res.status(404).send('Not found');
  }
};

Common.prototype.adminTypes = {
  ISSUE_THREAD_TX: 'issue_thread_transactions',
  ISSUE_RMG: 'issue_rmg',
  DESTROY_RMG: 'destroy_rmg',

  PROVISIONING_TX: 'provisioning_transactions',
  ROOT_THREAD: 'root_thread'

};

Common.prototype.adminTxsHex = function() {
  var self = this;
  return {
    '52bb': self.adminTypes.ISSUE_THREAD_TX ,
    '51bb': self.adminTypes.PROVISIONING_TX,
    '00bb': self.adminTypes.ROOT_THREAD,
  };
};

module.exports = Common;
