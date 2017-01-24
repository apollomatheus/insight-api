'use strict';

var bitcore = require('bitcore-lib');
var async = require('async');
var providers = require('../providers.json');
var keyHolders = require('../keyHolders.json');
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
    self.providerStrings[provider.key] = {
      name: provider.providerName,
      url: provider.url
    };
  });
  // List of backup key holders
  this.holderStrings = {};
  keyHolders.forEach(function(holder) {
    self.holderStrings[holder.key] = {
      name: holder.holderName,
      url: holder.url
    };
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
      walletProvider: self.getWalletProvider(address),
      backupKeyHolder: self.backupKeyHolder(address)
    };

    callback(null, transformed);
  });
};
//TODO: Use RPC method to get the providers info, RPC not implemented yet
AddressController.prototype.getWalletProvider = function(address) {
  var self = this;
  var addressInfo = new bitcore.Address(address);
  var pubkey1 = addressInfo.keyId1;
  var pubkey2 = addressInfo.keyId2;
  if (self.providerStrings[pubkey1]) {
    return self.providerStrings[pubkey1];
  }

  return self.providerStrings[pubkey2];
};

//TODO: Use RPC method to get the providers info, RPC not implemented yet
AddressController.prototype.backupKeyHolder = function(address) {
  var self = this;
  var addressInfo = new bitcore.Address(address);
  var pubkey1 = addressInfo.keyId1;
  var pubkey2 = addressInfo.keyId2;
  if (self.holderStrings[pubkey1]) {
    return self.holderStrings[pubkey1];
  }

  return self.holderStrings[pubkey2];
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
