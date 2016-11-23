'use strict';

var async = require('async');
var bitcore = require('bitcore-lib');
var _ = bitcore.deps._;
var pools = require('../pools.json');
var BN = bitcore.crypto.BN;
var LRU = require('lru-cache');
var Common = require('./common');

function BlockController(options) {
  var self = this;
  this.node = options.node;

  this.blockSummaryCache = LRU(options.blockSummaryCacheSize || BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE);
  this.blockCacheConfirmations = 6;
  this.blockCache = LRU(options.blockCacheSize || BlockController.DEFAULT_BLOCK_CACHE_SIZE);

  this.poolStrings = {};
  pools.forEach(function(pool) {
    pool.searchStrings.forEach(function(s) {
      self.poolStrings[s] = {
        poolName: pool.poolName,
        url: pool.url
      };
    });
  });

  this.common = new Common({log: this.node.log});
}

var BLOCK_LIMIT = 200;

BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE = 1000000;
BlockController.DEFAULT_BLOCK_CACHE_SIZE = 1000;

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
      self.node.services.bitcoind.getBlockHeader(hash, function(err, info) {
        if (err) {
          return self.common.handleErrors(err, res);
        }
        var blockResult = self.transformBlock(block, info);
        if (blockResult.confirmations >= self.blockCacheConfirmations) {
          self.blockCache.set(hash, blockResult);
        }
        req.block = blockResult;
        next();
      });
    });
  }
};

/**
 * Find rawblock by hash and height...
 */
BlockController.prototype.rawBlock = function(req, res, next) {
  var self = this;
  var blockHash = req.params.blockHash;

  self.node.getRawBlock(blockHash, function(err, blockBuffer) {
    if((err && err.code === -5) || (err && err.code === -8)) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }
    req.rawBlock = {
      rawblock: blockBuffer.toString('hex')
    };
    next();
  });

};

BlockController.prototype._normalizePrevHash = function(hash) {
  // TODO fix bitcore to give back null instead of null hash
  if (hash !== '0000000000000000000000000000000000000000000000000000000000000000') {
    return hash;
  } else {
    return null;
  }
};

BlockController.prototype.transformBlock = function(block, info) {
  var blockObj = block.toObject();
  var transactionIds = blockObj.transactions.map(function(tx) {
    return tx.hash;
  });
  return {
    hash: block.hash,
    size: block.toBuffer().length,
    height: info.height,
    version: blockObj.header.version,
    merkleroot: blockObj.header.merkleRoot,
    tx: transactionIds,
    time: blockObj.header.time,
    nonce: blockObj.header.nonce,
    bits: blockObj.header.bits.toString(16),
    difficulty: block.header.getDifficulty(),
    chainwork: info.chainWork,
    confirmations: info.confirmations,
    previousblockhash: this._normalizePrevHash(blockObj.header.prevHash),
    nextblockhash: info.nextHash,
    reward: this.getBlockReward(info.height) / 1e8,
    isMainChain: (info.confirmations !== -1),
    poolInfo: this.getPoolInfo(block)
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

BlockController.prototype.showRaw = function(req, res) {
  if (req.rawBlock) {
    res.jsonp(req.rawBlock);
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
  
  // Callback of bitcoind.getRawBlock
  function getRawBlock(err, blockBuffer) {
    
    if (err) {
      return next(err);
    }
    
    var br = new bitcore.encoding.BufferReader(blockBuffer);

    // take a shortcut to get number of transactions and the blocksize.
    // Also reads the coinbase transaction and only that.
    // Old code parsed all transactions in every block _and_ then encoded
    // them all back together to get the binary size of the block.
    // FIXME: This code might still read the whole block. Fixing that
    // would require changes in bitcore-node.
    var header = bitcore.BlockHeader.fromBufferReader(br);
    var info = {};
    var txlength = br.readVarintNum();
    info.transactions = [bitcore.Transaction().fromBufferReader(br)];
    
    self.node.services.bitcoind.getBlockHeader(hash, function(err, blockHeader) {
      if (err) {
        return next(err);
      }
      var height = blockHeader.height;

      var summary = {
        height: height,
        size: blockBuffer.length,
        hash: hash,
        time: header.time,
        txlength: txlength,
        poolInfo: self.getPoolInfo(info)
      };

      var confirmations = self.node.services.bitcoind.height - height + 1;
      if (confirmations >= self.blockCacheConfirmations) {
        self.blockSummaryCache.set(hash, summary);
      }

      finish(summary);
      
    });
  }
  
  // Checks in cache for the block, or fetch his data
  function getSummary(hash){
    var summaryCache = self.blockSummaryCache.get(hash);
    if (summaryCache) {
      finish(summaryCache);
    } else {
      self.node.services.bitcoind.getRawBlock(hash, getRawBlock);
    }
  }

  // Get the hash of the block by his height.
  this.node.services.bitcoind.getBlockHeader(parseInt(height), function(err, info) {
    if (err) {
      return self.common.handleErrors(err, res);
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
  
  //pagination
  var startingBlockHeight = req.query.height || null;
  var limit = parseInt(req.query.limit || BLOCK_LIMIT);
  var more = false;
  
  // We filter the blocks based on his height
  function filterBlocks() {
    var heights = []; // List of blocks to retrieve
    // Get N blocks
    // We start from block 1000, so we loop until the limit is reach,
    // looking for blocks height - 1 on each iteration
    for (var i = 0; i < limit; i++) {
      if (startingBlockHeight - 1 <= 0) {
        break;
      }
      heights.push(startingBlockHeight - i);
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
        
        res.jsonp({
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
  var coinbaseBuffer = block.transactions[0].inputs[0]._scriptBuffer;

  for(var k in this.poolStrings) {
    if (coinbaseBuffer.toString('utf-8').match(k)) {
      return this.poolStrings[k];
    }
  }

  return {};
};

//helper to convert timestamps to yyyy-mm-dd format
BlockController.prototype.formatTimestamp = function(date) {
  var yyyy = date.getUTCFullYear().toString();
  var mm = (date.getUTCMonth() + 1).toString(); // getMonth() is zero-based
  var dd = date.getUTCDate().toString();

  return yyyy + '-' + (mm[1] ? mm : '0' + mm[0]) + '-' + (dd[1] ? dd : '0' + dd[0]); //padding
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

module.exports = BlockController;
