'use strict';

var bitcore = require('bitcore-lib');
var _ = bitcore.deps._;
var $ = bitcore.util.preconditions;
var Common = require('./common');
var async = require('async');
var providers = require('../providers.json');

var MAXINT = 0xffffffff; // Math.pow(2, 32) - 1;

function TxController(node) {
  var self = this;
  this.node = node;
  this.common = new Common({log: this.node.log});

  this.providerStrings = {};
  providers.forEach(function(provider) {
    self.providerStrings[provider.pubkey] = provider;
  });
}

TxController.prototype.show = function(req, res) {
  if (req.transaction) {
    res.jsonp(req.transaction);
  }
};

/**
 * Find transaction by hash ...
 */
TxController.prototype.transaction = function(req, res, next) {
  var self = this;
  var txid = req.params.txid;

  this.node.getDetailedTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if (err) {
      return self.common.handleErrors(err, res);
    }

    self.transformTransaction(transaction, function(err, transformedTransaction) {
      if (err) {
        return self.common.handleErrors(err, res);
      }
      req.transaction = transformedTransaction;
      next();
    });

  });
};

TxController.prototype.getTransactionSigner = function(transaction) {
  var self = this;
  var input1 = transaction.vin[0];

  if (input1.scriptSig && input1.scriptSig.asm) {

    var asm = input1.scriptSig.asm.split(' ');
    var key1 = self.providerStrings[asm[0]] || { pubkey: asm[0] };
    var key2 = self.providerStrings[asm[2]] || { pubkey: asm[2] };

    return { key1: key1, key2: key2 };
  }
};

TxController.prototype.isAdminTx = function(transaction) {
  return transaction.outputs && transaction.outputs[0].type === 'admin';
};

/**
 * Get issuance information about the transaction
 * There are 2 types of issuance transactions
 * 1. Issue funds
 * 2. Destroying funds
 *
 * To identify if is issuance new funds we can:
 * Outputs must
 *  - asm != 'op_return'
 *
 * To identify if is destroying funds we can:
 *  - asm === 'op_return'
 */
TxController.prototype.getIssuanceTxInfo = function(transaction) {
  // Let's return the issuance value
  var outputsBalance = transaction.outputs.slice(1).reduce(function(acc, val) {
    return acc + val.satoshis;
  }, 0);

  // Issuing funds & destroying cannot be in the same tx, let's just check the first output
  // to identify the type of tx
  var type = this.common.adminTypes.ISSUE_RMG;
  if (transaction.outputs[1].scriptAsm === 'OP_RETURN') {
    type = this.common.adminTypes.DESTROY_RMG;
  }

  return {
    balance: outputsBalance,
    type: type
  };
};

// TODO: Return important information about this
TxController.prototype.getProvisioningTxInfo = function(transaction) {
  return {
    type: this.common.adminTypes.PROVISIONING_TX
  }
};

// TODO: Return important information about this
TxController.prototype.getRootThreadInfo = function(transaction) {
  return {
    type: this.common.adminTypes.ROOT_THREAD
  }
};


/*
* Let's just identify the raw type by the moment but we will need much more than this
* https://app.asana.com/0/103309069131564/280659190696822
*/
TxController.prototype.getAdminTxInfo = function(transaction) {
  var self = this;

  var adminTxsHex = this.common.adminTxsHex();
  var adminType = adminTxsHex[transaction.outputs[0].script];

  if (adminType === this.common.adminTypes.ISSUE_THREAD_TX) {
    return self.getIssuanceTxInfo(transaction);
  }

  if (adminType === this.common.adminTypes.PROVISIONING_TX) {
    return self.getProvisioningTxInfo(transaction);
  }

  if (adminType === this.common.adminTypes.ROOT_THREAD) {
    return self.getRootThreadInfo(transaction);
  }

};

TxController.prototype.transformTransaction = function(transaction, options, callback) {
  var self = this;

  if (_.isFunction(options)) {
    callback = options;
    options = {};
  }
  $.checkArgument(_.isFunction(callback));

  var transformed = {
    txid: transaction.hash,
    version: transaction.version,
    locktime: transaction.locktime
  };

  if (transaction.coinbase) {
    transformed.vin = [
      {
        coinbase: transaction.inputs[0].script,
        sequence: transaction.inputs[0].sequence,
        n: 0
      }
    ];
  } else {
    transformed.vin = transaction.inputs.map(self.transformInput.bind(self, options));
    transformed.signer = self.getTransactionSigner(transformed);
  }

  transformed.vout = transaction.outputs.map(self.transformOutput.bind(self, options));

  transformed.blockhash = transaction.blockHash;
  transformed.blockheight = transaction.height;
  transformed.confirmations = transaction.confirmations;;
  // TODO consider mempool txs with receivedTime?
  var time = transaction.blockTimestamp ? transaction.blockTimestamp : Math.round(Date.now() / 1000);
  transformed.time = time;
  if (transformed.confirmations) {
    transformed.blocktime = transformed.time;
  }
  // It is an admin tx?
  if (self.isAdminTx(transaction)) {
    transformed.isAdminTransaction = true;
    transformed.adminInfo = self.getAdminTxInfo(transaction);
  }
  // It is a coinbase tx?
  if (transaction.coinbase) {
    transformed.isCoinBase = true;
  }
  // Does it have hex? Admin tx's don't
  if (transaction.hex) {
    transformed.size = transaction.hex.length / 2; // in bytes
  }
  // If is not coinbase read the input value & fees
  if (!transaction.coinbase) {
    transformed.valueIn = transaction.inputSatoshis / 1e8;
    transformed.fees = transaction.feeSatoshis / 1e8;
  }

  transformed.valueOut = transaction.outputSatoshis / 1e8;
  callback(null, transformed);
};



TxController.prototype.transformInput = function(options, input, index) {
  // Input scripts are validated and can be assumed to be valid
  var transformed = {
    txid: input.prevTxId,
    vout: input.outputIndex,
    sequence: input.sequence,
    n: index
  };

  if (!options.noScriptSig) {
    transformed.scriptSig = {
      hex: input.script
    };
    if (!options.noAsm) {
      transformed.scriptSig.asm = input.scriptAsm;
    }
  }

  transformed.addr = input.address;
  transformed.valueSat = input.satoshis;
  transformed.value = input.satoshis / 1e8;
  transformed.doubleSpentTxID = null; // TODO
  //transformed.isConfirmed = null; // TODO
  //transformed.confirmations = null; // TODO
  //transformed.unconfirmedInput = null; // TODO

  return transformed;
};

TxController.prototype.transformOutput = function(options, output, index) {
  var transformed = {
    value: (output.satoshis / 1e8).toFixed(8),
    n: index,
    scriptPubKey: {
      hex: output.script
    }
  };

  if (!options.noAsm) {
    transformed.scriptPubKey.asm = output.scriptAsm;
  }

  if (!options.noSpent) {
    transformed.spentTxId = output.spentTxId || null;
    transformed.spentIndex = _.isUndefined(output.spentIndex) ? null : output.spentIndex;
    transformed.spentHeight = output.spentHeight || null;
  }

  if (output.address) {
    transformed.scriptPubKey.addresses = [output.address];
  }
  return transformed;
};

TxController.prototype.transformInvTransaction = function(transaction) {
  var self = this;
  var valueOut = 0;
  var vout = [];
  for (var i = 0; i < transaction.vout.length; i++) {
    var output = transaction.vout[i];
    valueOut += new bitcore.Unit.fromBTC(output.value).toSatoshis();
    if (output.scriptPubKey && output.scriptPubKey.addresses) {
      var address = output.scriptPubKey.addresses[0];
      if (address) {
        var obj = {};
        obj[address] = new bitcore.Unit.fromBTC(output.value).toSatoshis();
        vout.push(obj);
      }
    }
  }

  var isRBF = _.any(_.pluck(transaction.vin, 'sequenceNumber'), function(seq) {
    return seq < MAXINT - 1;
  });

  var transformed = {
    txid: transaction.txid,
    valueOut: valueOut / 1e8,
    vout: vout,
    isRBF: isRBF,
  };
  
  return transformed;
};


var getBlockTxList = function(req, res, options) {
  var self = options.self;
  self.node.getBlockOverview(options.blockHash, function(err, block) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if (err) {
      return self.common.handleErrors(err, res);
    }

    var totalTxs = block.txids.length;
    var txids;

    if (!_.isUndefined(options.page)) {
      var start = options.page * options.pageLength;
      txids = block.txids.slice(start, start + options.pageLength);
      options.pagesTotal = Math.ceil(totalTxs / options.pageLength);
    } else {
      txids = block.txids;
    }

    async.mapSeries(txids, function(txid, next) {
      self.node.getDetailedTransaction(txid, function(err, transaction) {
        if (err) {
          return next(err);
        }
        self.transformTransaction(transaction, next);
      });
    }, function(err, transformed) {
      if (err) {
        return self.common.handleErrors(err, res);
      }

      res.jsonp({
        pagesTotal: options.pagesTotal,
        txs: transformed
      });
    });

  });
};

var addressTxList = function(req, res, options) {
  var self = options.self;

  options.from = options.page * options.pageLength;
  options.to = (options.page + 1) * options.pageLength;

  self.node.getAddressHistory(options.address, options, function(err, result) {
    if (err) {
      return self.common.handleErrors(err, res);
    }

    var txs = result.items.map(function(info) {
      return info.tx;
    }).filter(function(value, index, self) {
      return self.indexOf(value) === index;
    });

    async.map(
      txs,
      function(tx, next) {
        self.transformTransaction(tx, next);
      },
      function(err, transformed) {
        if (err) {
          return self.common.handleErrors(err, res);
        }
        res.jsonp({
          pagesTotal: Math.ceil(result.totalCount / options.pageLength),
          txs: transformed
        });
      }
    );
  });
};

TxController.prototype.list = function(req, res) {
  var self = this;

  var options = {
    blockHash : req.query.block,
    address : req.query.address,
    page : parseInt(req.query.pageNum) || 0,
    pageLength : 10,
    pagesTotal : 1,
    self: self
  };

  if (options.blockHash) {
    return getBlockTxList(req, res, options);
  } else if (options.address) {
    return addressTxList(req, res, options);
  } else {
    return self.common.handleErrors(new Error('Block hash or address expected'), res);
  }
};

TxController.prototype.send = function(req, res) {
  var self = this;
  this.node.sendTransaction(req.body.rawtx, function(err, txid) {
    if (err) {
      // TODO handle specific errors
      return self.common.handleErrors(err, res);
    }

    res.json({'txid': txid});
  });
};

TxController.prototype.decodeRawTransaction = function(req, res) {
  var self = this;
  this.node.decodeRawTransaction(req.body.rawtx, function(err, decodedTx) {
    if (err) {
      // TODO handle specific errors
      return self.common.handleErrors(err, res);
    }

    res.json(decodedTx);
  });
};

module.exports = TxController;
