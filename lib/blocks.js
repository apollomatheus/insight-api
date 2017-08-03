'use strict';

var async = require('async');
var bitcore = require('bitcore-lib');
var _ = bitcore.deps._;
var BN = bitcore.crypto.BN;
var LRU = require('lru-cache');
var Common = require('./common');
var EventEmitter = require('events').EventEmitter;
var messageBus = new EventEmitter();

// We might need to increase this we start getting more and more users
messageBus.setMaxListeners(1000);

function BlockController(options) {
  var self = this;
  this.node = options.node;

  this.blockSummaryCache = LRU(options.blockSummaryCacheSize || BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE);
  this.blockCacheConfirmations = 6;
  this.blockCache = LRU(options.blockCacheSize || BlockController.DEFAULT_BLOCK_CACHE_SIZE);
  this.latestBlocksCache = LRU(options.latestBlockCacheSize || BlockController.DEFAULT_LATESTBLOCKS_CACHE_SIZE);

  var validators = require('./keys/testnet/validators.json');
  if(global.network === 'livenet' || global.network === 'mainnet') {
    validators = require('./keys/mainnet/validators.json');
  }

  this.validatorStrings = {};
  validators.forEach(function(validator) {
    self.validatorStrings[validator.key] = validator;
  });

  this.common = new Common({log: this.node.log});
}

var BLOCK_LIMIT = 200;
var LATEST_BLOCK_LIMIT = 5;

BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE = 1000000;
BlockController.DEFAULT_BLOCK_CACHE_SIZE = 1000;
BlockController.DEFAULT_LATESTBLOCKS_CACHE_SIZE = BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE * LATEST_BLOCK_LIMIT;

function isHexadecimal(hash) {
  if (!_.isString(hash)) {
    return false;
  }
  return /^[0-9a-fA-F]+$/.test(hash);
}

BlockController.prototype.checkBlockHash = function(req, res, next) {
  var self = this;
  var hash = req.params.blockHash;
  if (hash.length < 64 || !isHexadecimal(hash)) {
    return self.common.handleErrors(null, res);
  }
  next();
};

/**
 * Find block by hash ...
 */
BlockController.prototype.block = function(req, res, next) {
  var self = this;
  var hash = req.params.blockHash;
  var blockCached = self.blockCache.get(hash);

  if (blockCached) {
    blockCached.confirmations = self.node.services.bitcoind.height - blockCached.height + 1;
    req.block = blockCached;
    next();
  } else {
    self.node.getBlock(hash, function(err, block) {
      if((err && err.code === -5) || (err && err.code === -8)) {
        return self.common.handleErrors(null, res);
      } else if(err) {
        return self.common.handleErrors(err, res);
      }
      var blockResult = self.transformBlock(block);
      if (blockResult.confirmations >= self.blockCacheConfirmations) {
        self.blockCache.set(hash, blockResult);
      }
      req.block = blockResult;
      next();
    });
  }
};

BlockController.prototype._normalizePrevHash = function(hash) {
  // TODO fix bitcore to give back null instead of null hash
  if (hash !== '0000000000000000000000000000000000000000000000000000000000000000') {
    return hash;
  } else {
    return null;
  }
};

BlockController.prototype.transformBlock = function(blockObj) {
  return {
    hash: blockObj.hash,
    size: blockObj.size,
    height: blockObj.height,
    version: blockObj.version,
    merkleroot: blockObj.merkleroot,
    tx:  blockObj.tx,
    time: blockObj.time,
    nonce: blockObj.nonce,
    bits: blockObj.bits,
    difficulty: blockObj.difficulty,
    chainwork: blockObj.chainWork,
    confirmations: blockObj.confirmations,
    previousblockhash: this._normalizePrevHash(blockObj.previousblockhash),
    nextblockhash: blockObj.nextblockhash,
    reward: this.getBlockReward(blockObj.height) / 1e8,
    isMainChain: (blockObj.confirmations !== -1),
    validatorInfo: this.getPoolInfo(blockObj)
  };
};

/**
 * Show block
 */
BlockController.prototype.show = function(req, res) {
  if (req.block) {
    res.jsonp(req.block);
  }
};

BlockController.prototype.blockIndex = function(req, res) {
  var self = this;
  var height = req.params.height;
  this.node.services.bitcoind.getBlockHeader(parseInt(height), function(err, info) {
    if (err) {
      return self.common.handleErrors(err, res);
    }
    res.jsonp({
      blockHash: info.hash
    });
  });
};

/**
 * Receives a block height and returns a json object with data
 * @param height <int> Height of the block to search for
 * @param next <fn> Callback
 */
BlockController.prototype._getBlockSummary = function(height, next) {
  var self = this;
  var hash = null;
  // Finish function by calling the callback
  function finish(result) {
    return next(null, result);
  }
  
  // Callback of bitcoind.getBlock
  function getBlock(err, block) {
    
    if (err) {
      return next(err);
    }

    var info = {};
    info.transactions = block.tx;

    var summary = {
      height: block.height,
      size: block.size,
      hash: block.hash,
      time: block.time,
      txlength: block.tx.length,
      validatorInfo: self.getPoolInfo(block)
    };

    var confirmations = block.height;
    if (confirmations >= self.blockCacheConfirmations) {
      self.blockSummaryCache.set(hash, summary);
    }

    finish(summary);
  }
  
  // Checks in cache for the block, or fetch his data
  function getSummary(hash){
    var summaryCache = self.blockSummaryCache.get(hash);
    if (summaryCache) {
      finish(summaryCache);
    } else {
      self.node.services.bitcoind.getBlock(hash, getBlock);
    }
  }

  // Get the hash of the block by his height.
  this.node.services.bitcoind.getBlockHeader(parseInt(height), function(err, info) {
    if (err) {
      return self.common.handleErrors(err, next);
    }
    hash = info.hash;
    // Get the block data
    getSummary(hash);
  });
    
};

/**
 *  List blocks
 *  limit=<number> Number of blocks to return.
 *  height=<number> Staring block to retrieve
 *  Get a list of block until limit is reached. Staring
 *  from the height parameter, if no height is passed,
 *  getBestBlockHash is used.
 */
BlockController.prototype.list = function(req, res) {
  var self = this;

  self._list(req.query.height, req.query.limit, function(data){
    res.jsonp(data);
  });
};

BlockController.prototype._list = function(startingBlockHeight, limit, callback) {
  var self = this;

  //pagination
  var startingBlockHeight = startingBlockHeight || null;
  var limit = parseInt(limit || BLOCK_LIMIT);
  // We filter the blocks based on his height
  function filterBlocks() {
    var heights = []; // List of blocks to retrieve
    // Get previous heights
    for (var i = limit; i > 0; i--) {
      if (startingBlockHeight < 0) {
        break;
      }
      heights.push(startingBlockHeight--);
    }
    // For each height, get the block data
    async.mapSeries(
      heights,
      function(height, next) {
        self._getBlockSummary(height, next);
      },
      function(err, blocks) {
        if(err) {
          return self.common.handleErrors(err, res);
        }
        // Sort the list of final blocks
        blocks.sort(function(a, b) {
          return b.height - a.height;
        });

        callback({
          blocks: blocks,
          length: blocks.length
        });
      }
    );
  }

  // Gets the best block (current) calling by calling bitcoind.getBlockHeader
  function getBestBlockHash(err, hash) {
    if (err) {
      return self.common.handleErrors(err, res);
    }
    // We filter by height, so let's get the height of the best block and filter the blocks based on that.
    self.node.services.bitcoind.getBlockHeader(hash, function(err, info) {
      if (err) {
        return self.common.handleErrors(err, res);
      }
      startingBlockHeight = info.height;
      filterBlocks();
    });
  }

  // This method filter by an starting block height,
  // if no height is passed we get the latest from the bitcoind.getBestBlockHash
  if (!startingBlockHeight) {
    self.node.services.bitcoind.getBestBlockHash(getBestBlockHash);
  } else {
    filterBlocks();
  }
};

BlockController.prototype.getPoolInfo = function(block) {
  return this.validatorStrings[block.validatingpubkey] || {key: block.validatingpubkey};
};

BlockController.prototype.getBlockReward = function(height) {
  var halvings = Math.floor(height / 210000);
  // Force block reward to zero when right shift is undefined.
  if (halvings >= 64) {
    return 0;
  }

  // Subsidy is cut in half every 210,000 blocks which will occur approximately every 4 years.
  var subsidy = new BN(50 * 1e8);
  subsidy = subsidy.shrn(halvings);

  return parseInt(subsidy.toString(10));
};

/**
 * Returns latest new block
 * @param req
 * @param res
 */
BlockController.prototype.getLatestBlock = function(req, res, next) {
  var newBlockCallback = function(blockHash){

    if(!req.params) {
      req.params = {
        blockHash: blockHash
      }
    } else {
      req.params.blockHash = blockHash;
    }


    // kill that timer for the response timing out.
    if(timer) {
      clearTimeout(timer);
    }

    next();
  };
  messageBus.once('newBlock', newBlockCallback);

  var timer = setTimeout(function() {
    // too long has passed so remove listener and end response.
    messageBus.removeListener('newBlock', newBlockCallback);
    res.status(408).send();
  }, 60 * 5 * 1000);
};

BlockController.prototype.emitNewBlock = function(block) {
  messageBus.emit('newBlock', block);
};

module.exports = BlockController;
