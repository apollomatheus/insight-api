'use strict';

var bitcore = require('bitcore-lib');
var async = require('async');
var providers = require('../providers.json');
var TxController = require('./transactions');
var Common = require('./common');

function AddressController(node) {
  var self = this;
  this.node = node;
  this.txController = new TxController(node);
  this.common = new Common({log: this.node.log});
  // List of wallet providers
  this.providerStrings = {};
  providers.forEach(function(provider) {
    self.providerStrings[provider.keyid] = provider;
  });
}

AddressController.prototype.show = function(req, res) {
  var self = this;
  var options = {
    noTxList: parseInt(req.query.noTxList)
  };

  if (req.query.from && req.query.to) {
    options.from = parseInt(req.query.from);
    options.to = parseInt(req.query.to);
  }

  this.getAddressSummary(req.addr, options, function(err, data) {
    if(err) {
      return self.common.handleErrors(err, res);
    }

    res.jsonp(data);
  });
};

AddressController.prototype.getAddressSummary = function(address, options, callback) {
  var self = this;
  this.node.getAddressSummary(address, options, function(err, summary) {
    if(err) {
      return callback(err);
    }

    var addressWsp = self.getWSP(address);

    var transformed = {
      addrStr: address,
      balance: summary.balance / 1e8,
      balanceSat: summary.balance,
      totalReceived: summary.totalReceived / 1e8,
      totalReceivedSat: summary.totalReceived,
      totalSent: summary.totalSpent / 1e8,
      totalSentSat: summary.totalSpent,
      unconfirmedBalance: summary.unconfirmedBalance / 1e8,
      unconfirmedBalanceSat: summary.unconfirmedBalance,
      unconfirmedTxApperances: summary.unconfirmedAppearances, // misspelling - ew
      txApperances: summary.appearances, // yuck
      transactions: summary.txids,
      wsp1: addressWsp.key1,
      wsp2: addressWsp.key2
    };

    callback(null, transformed);
  });
};

/**
 * The address structure is
 * <Version 1 byte><Pub Hash 20 bytes><key 1 4bytes><key 2 4bytes>
 * The keys aren't in any particular order so technically it is not possible to identify
 * which is the wallet provider or the backup key holder, actually it is possible to have
 * 2 wallet providers and no backup key holders.
 * Let's return the mapping for each key.
 */
AddressController.prototype.getWSP = function(address) {
  var self = this;
  var addressInfo = new bitcore.Address(address);
  var key1 = self.providerStrings[addressInfo.keyId1] || { keyid: addressInfo.keyId1 };
  var key2 = self.providerStrings[addressInfo.keyId2] || { keyid: addressInfo.keyId2 };

  return { key1: key1, key2: key2}
};

AddressController.prototype.checkAddr = function(req, res, next) {
  req.addr = req.params.addr;
  this.check(req, res, next, [req.addr]);
};

AddressController.prototype.check = function(req, res, next, addresses) {
  var self = this;
  if(!addresses.length || !addresses[0]) {
    return self.common.handleErrors({
      message: 'Must include address',
      code: 1
    }, res);
  }

  for(var i = 0; i < addresses.length; i++) {
    try {
      var a = new bitcore.Address(addresses[i]);
    } catch(e) {
      return self.common.handleErrors({
        message: 'Invalid address: ' + e.message,
        code: 1
      }, res);
    }
  }

  next();
};

module.exports = AddressController;
