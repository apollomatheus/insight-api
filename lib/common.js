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
  VALIDATE_KEY_ADD: 'validate_key_add',
  VALIDATE_KEY_REVOKE: 'validate_key_revoke',
  ASP_KEY_ADD: 'asp_key_add',
  ASP_KEY_REVOKE: 'asp_key_revoke',

  ROOT_THREAD: 'root_thread',
  ISSUE_KEY_ADD: 'issue_key_add',
  ISSUE_KEY_REVOKE: 'issue_key_revoke',
  PROVISION_KEY_ADD: 'provision_key_add',
  PROVISION_KEY_REVOKE: 'provision_key_revoke'

};

Common.prototype.adminTxsHex = function() {
  var self = this;
  return {
    '52bb': self.adminTypes.ISSUE_THREAD_TX ,
    '51bb': self.adminTypes.PROVISIONING_TX,
    '00bb': self.adminTypes.ROOT_THREAD,
  };
};

/*
 * case issueKeyAdd = 1 // 0x01 // 01
 * case issueKeyRevoke = 2 // 0x02 // 02
 * case provisionKeyAdd = 3 // 0x03 // 03
 * case provisionKeyRevoke = 4 // 0x04 // 04
 * case validateKeyAdd = 17 // 0x11 // 11
 * case validateKeyRevoke = 18 // 0x12 // 12
 * case aspKeyAdd = 19 // 0x13 // 13
 * case aspKeyRevoke = 20 // 0x14 //14
 */
Common.prototype.firstAdminASMHexBytes = function() {
  var self = this;
  return {
    // ROOT THREAD TRANSACTIONS
    '01': self.adminTypes.ISSUE_KEY_ADD,
    '02': self.adminTypes.ISSUE_KEY_REVOKE,

    '03': self.adminTypes.PROVISION_KEY_ADD,
    '04': self.adminTypes.PROVISION_KEY_REVOKE,
    // PROVISIONING THREAD TRANSACTIONS
    '11': self.adminTypes.VALIDATE_KEY_ADD,
    '12': self.adminTypes.VALIDATE_KEY_REVOKE,

    '13': self.adminTypes.ASP_KEY_ADD,
    '14': self.adminTypes.ASP_KEY_REVOKE,
  };
};

module.exports = Common;
