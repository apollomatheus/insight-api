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
    self.providerStrings[provider.key] = {
      name: provider.providerName,
      url: provider.url
    };
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
    } else if(err) {
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
    var pubkey1 = asm[0];
    var pubkey2 = asm[2];
    if (self.providerStrings[pubkey1]) {
      return self.providerStrings[pubkey1];
    }

    return self.providerStrings[pubkey2];
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

  if(transaction.coinbase) {
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

  if(transaction.coinbase) {
    transformed.isCoinBase = true;
  }

  transformed.valueOut = transaction.outputSatoshis / 1e8;
  transformed.size = transaction.hex.length / 2; // in bytes
  if (!transaction.coinbase) {
    transformed.valueIn = transaction.inputSatoshis / 1e8;
    transformed.fees = transaction.feeSatoshis / 1e8;
  }

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

TxController.prototype.rawTransaction = function(req, res, next) {
  var self = this;
  var txid = req.params.txid;

  this.node.getTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    req.rawTransaction = {
      'rawtx': transaction.toBuffer().toString('hex')
    };

    next();
  });
};

TxController.prototype.showRaw = function(req, res) {
  if (req.rawTransaction) {
    res.jsonp(req.rawTransaction);
  }
};

var getBlockTxList = function(req, res, options) {
  var self = options.self;
  self.node.getBlockOverview(options.blockHash, function(err, block) {
    if(err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    var totalTxs = block.txids.length;
    var txids;

    if(!_.isUndefined(options.page)) {
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
      if(err) {
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
    if(err) {
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

  if(options.blockHash) {
    return getBlockTxList(req, res, options);
  } else if(options.address) {
    return addressTxList(req, res, options);
  } else {
    return self.common.handleErrors(new Error('Block hash or address expected'), res);
  }
};

TxController.prototype.send = function(req, res) {
  var self = this;
  this.node.sendTransaction(req.body.rawtx, function(err, txid) {
    if(err) {
      // TODO handle specific errors
      return self.common.handleErrors(err, res);
    }

    res.json({'txid': txid});
  });
};

TxController.prototype.decodeRawTransaction = function(req, res) {
  var self = this;
  this.node.decodeRawTransaction(req.body.rawtx, function(err, decodedTx) {
    if(err) {
      // TODO handle specific errors
      return self.common.handleErrors(err, res);
    }

    res.json(decodedTx);
  });
};

module.exports = TxController;
