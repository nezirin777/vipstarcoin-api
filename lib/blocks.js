'use strict';

var async = require('async');
var bitcore = require('vipstarcoin-lib');
var _ = bitcore.deps._;
var pools = require('../pools.json');
var BN = bitcore.crypto.BN;
var LRU = require('lru-cache');
var Common = require('./common');

function BlockController(options) {
    var self = this;
    this.node = options.node;
    this.transactionService = options.transactionService;

    this.blockSummaryCache = LRU(options.blockSummaryCacheSize || BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE);
    this.blockCacheConfirmations = 6;
    this.blockCache = LRU(options.blockCacheSize || BlockController.DEFAULT_BLOCK_CACHE_SIZE);

    this.poolStrings = {};
    pools.forEach(function (pool) {
        pool.searchStrings.forEach(function (s) {
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


BlockController.prototype.checkBlockHash = function (req, res, next) {
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
BlockController.prototype.block = function (req, res, next) {
    var self = this;
    var hash = req.params.blockHash;

    return this.getBlockByHash(hash, function (err, blockResult) {
        if ((err && err.code === -5) || (err && err.code === -8)) {
            return self.common.handleErrors(null, res);
        } else if (err) {
            return self.common.handleErrors(err, res);
        }

        req.block = blockResult;

        return next();
    });

};

/**
 *
 * @param {String} hash
 * @param {Function} next
 * @returns {*}
 */
BlockController.prototype.getBlockByHash = function (hash, next) {

    var self = this,
        blockCached = self.blockCache.get(hash);

    if (blockCached) {

        blockCached.confirmations = self.node.services.vipstarcoind.height - blockCached.height + 1;

        return next(null, blockCached);

    } else {

        var dataFlow = {
            block: null,
            info: null,
            reward: null,
            transaction: null
        };

        return async.waterfall([function (callback) {

            return self.node.getBlock(hash, function (err, block) {

                if (err) {
                    return callback(err);
                }

                dataFlow.block = block;

                return callback();
            });

        }, function (callback) {

            return self.node.services.vipstarcoind.getBlockHeader(hash, function (err, info) {

                if (err) {
                    return callback(err);
                }

                dataFlow.info = info;

                return callback();
            });

        }, function (callback) {

            return self.node.getSubsidy(dataFlow.info.height, function (err, result) {

                if (err) {
                    return callback(err);
                }

                dataFlow.reward = result;

                return callback();

            });

        }, function (callback) {

            if (dataFlow.info.height === 0) {
                return callback();
            }

            var txHash;

            if (dataFlow.block.header.isProofOfStake()) {
                txHash = dataFlow.block.transactions[1].hash;
            } else {
                txHash = dataFlow.block.transactions[0].hash;
            }

            return self.transactionService.getDetailedTransaction(txHash, function (err, trx) {

                if (err) {
                    return callback(err);
                }

                dataFlow.transaction = trx;

                return callback();

            });
          }, function (callback) {
            // Step 5: PoS の場合、coinstake input の前の出力から staker アドレスを解決
            if (!dataFlow.block.header.isProofOfStake()) { return callback(); }
            if (!dataFlow.transaction || !dataFlow.transaction.inputs ||
              !dataFlow.transaction.inputs[0]) { return callback(); }

            var input = dataFlow.transaction.inputs[0];
            if (input.address) { return callback(); } // 既に解決済み

            var prevTxidBuf = input.prevTxId;
            var prevTxid = Buffer.isBuffer(prevTxidBuf)
              ? prevTxidBuf.toString('hex')
              : prevTxidBuf;
            var prevVout = input.outputIndex;

            if (!prevTxid) { return callback(); }

            self.node.services.vipstarcoind.client.getRawTransaction(prevTxid, 1, function (err, prevRes) {
              if (err || !prevRes || !prevRes.result) { return callback(); }

              var prevOutput = prevRes.result.vout && prevRes.result.vout[prevVout];
              if (!prevOutput || !prevOutput.scriptPubKey) { return callback(); }

              var spk = prevOutput.scriptPubKey;

              // P2PKH
              if (spk.addresses && spk.addresses[0]) {
                input.address = spk.addresses[0];
                return callback();
              }

              // P2PK → Address 変換
              if (spk.type === 'pubkey' && spk.hex) {
                try {
                  var script = new bitcore.Script(Buffer.from(spk.hex, 'hex'));
                  if (script.isPublicKeyOut()) {
                    var pubkey = new bitcore.PublicKey(script.chunks[0].buf);
                    input.address = new bitcore.Address(pubkey, bitcore.Networks.livenet).toString();
                  }
                } catch (e) {
                  self.node.log.error('[getBlockByHash] P2PK→Address error: ' + e.message);
                }
              }
              callback();
            });
          }
        ], function (err) {

            if (err) {
                return next(err);
            }

            var blockResult = self.transformBlock(dataFlow.block, dataFlow.info, dataFlow.reward, dataFlow.transaction);

            if (blockResult.confirmations >= self.blockCacheConfirmations) {
                self.blockCache.set(hash, blockResult);
            }

            return next(null, blockResult);

        });

    }
};

/**
 * Find rawblock by hash and height...
 */
BlockController.prototype.rawBlock = function (req, res, next) {
    var self = this;
    var blockHash = req.params.blockHash;

    self.node.getRawBlock(blockHash, function (err, blockBuffer) {
        if ((err && err.code === -5) || (err && err.code === -8)) {
            return self.common.handleErrors(null, res);
        } else if (err) {
            return self.common.handleErrors(err, res);
        }
        req.rawBlock = {
            rawblock: blockBuffer.toString('hex')
        };
        next();
    });

};

BlockController.prototype._normalizePrevHash = function (hash) {
    // TODO fix bitcore to give back null instead of null hash
    if (hash !== '0000000000000000000000000000000000000000000000000000000000000000') {
        return hash;
    } else {
        return null;
    }
};

BlockController.prototype.transformBlock = function (block, info, reward, transaction) {
    var blockObj = block.toObject(),
        transactionIds = blockObj.transactions.map(function (tx) {
            return tx.hash;
        }),
        minedBy,
        flags;

    if (transaction) {
        if (block.header.isProofOfStake()) {
            minedBy = transaction.inputs[0].address;
            flags = 'proof-of-stake';
        } else {
            minedBy = transaction.outputs[0].address;
            flags = 'proof-of-work';
        }
    }

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
        flags: flags,
        reward: reward / 1e8,
        isMainChain: (info.confirmations !== -1),
        minedBy: minedBy,
        poolInfo: {}
    };

};

/**
 * Show block
 */
BlockController.prototype.show = function (req, res) {
    if (req.block) {
        res.jsonp(req.block);
    }
};

BlockController.prototype.showRaw = function (req, res) {
    if (req.rawBlock) {
        res.jsonp(req.rawBlock);
    }
};

BlockController.prototype.blockIndex = function (req, res) {
    var self = this;
    var height = req.params.height;
    this.node.services.vipstarcoind.getBlockHeader(parseInt(height), function (err, info) {
        if (err) {
            return self.common.handleErrors(err, res);
        }
        res.jsonp({
            blockHash: info.hash
        });
    });
};

BlockController.prototype._getBlockSummary = function (hash, moreTimestamp, next) {
  var self = this;

  function finish(result) {
    if (moreTimestamp > result.time) {
      moreTimestamp = result.time;
    }
    return next(null, result);
  }

  var summaryCache = self.blockSummaryCache.get(hash);

  if (summaryCache) {
    return async.setImmediate(function () {
      finish(summaryCache);
    });
  }

  var block;
  var transaction;
  var stakerAddress = null;

  return async.waterfall([

    // Step 1: ブロック取得
    function (callback) {
      return self.node.services.vipstarcoind.client.getBlock(hash, function (err, response) {
        if (err) { return callback(err); }
        if (!response) { return callback('Error getBlock'); }
        block = response.result;
        return callback();
      });
    },

    // Step 2: PoS=coinstake(tx[1]) / PoW=coinbase(tx[0]) を取得
    function (callback) {
      var txHash;
      if (block.flags === bitcore.Block.PROOF_OF_STAKE && block.tx && block.tx.length >= 2) {
        txHash = block.tx[1];
      } else if (block.flags === bitcore.Block.PROOF_OF_WORK && block.tx && block.tx.length >= 1) {
        txHash = block.tx[0];
      }
      if (!txHash) {
        return callback();
      }

      self.node.services.vipstarcoind.client.getRawTransaction(txHash, 1, function (err, txRes) {
        if (err) {
          self.node.log.error('[DEBUG] getRawTransaction err=' + JSON.stringify(err));
          return callback();
        }
        if (!txRes || !txRes.result) {
          self.node.log.error('[DEBUG] getRawTransaction no result txRes=' + JSON.stringify(txRes));
          return callback();
        }
        transaction = txRes.result;
        callback();
      });
    },

    // Step 3: P2PKH または P2PK の prevOutput からステーカーアドレスを解決
    function (callback) {
      if (block.flags !== bitcore.Block.PROOF_OF_STAKE) { return callback(); }
      if (!transaction || !transaction.vin || !transaction.vin[0]) { return callback(); }

      var prevTxid = transaction.vin[0].txid;
      var prevVout = transaction.vin[0].vout;
      if (!prevTxid) { return callback(); }

      self.node.services.vipstarcoind.client.getRawTransaction(prevTxid, 1, function (err, prevRes) {
        if (err || !prevRes || !prevRes.result) { return callback(); }

        var prevOutput = prevRes.result.vout && prevRes.result.vout[prevVout];
        if (!prevOutput || !prevOutput.scriptPubKey) { return callback(); }

        var spk = prevOutput.scriptPubKey;

        // P2PKH: addresses フィールドに直接アドレスがある
        if (spk.addresses && spk.addresses[0]) {
          stakerAddress = spk.addresses[0];
          return callback();
        }

        // P2PK: 公開鍵から VIPS アドレスに変換
        if (spk.type === 'pubkey' && spk.hex) {
          try {
            var script = new bitcore.Script(Buffer.from(spk.hex, 'hex'));
            if (script.isPublicKeyOut()) {
              var pubkey = new bitcore.PublicKey(script.chunks[0].buf);
              stakerAddress = new bitcore.Address(pubkey, bitcore.Networks.livenet).toString();
            }
          } catch (e) {
            self.node.log.error('[_getBlockSummary] P2PK→Address error: ' + e.message);
          }
        }

        callback();
      });
    },

  ], function (err) {

    if (err) { return next(err); }

    var summary = {
      height: block.height,
      size: block.size,
      hash: block.hash,
      time: block.time,
      txlength: block.tx.length,
      poolInfo: {},
      isMainChain: (block.confirmations !== -1)
    };

    if (block.flags === bitcore.Block.PROOF_OF_STAKE) {
      summary.minedBy = stakerAddress;
    } else if (transaction && transaction.vout && transaction.vout[0] &&
      transaction.vout[0].scriptPubKey &&
      transaction.vout[0].scriptPubKey.addresses) {
      summary.minedBy = transaction.vout[0].scriptPubKey.addresses[0];
    }

    var confirmations = self.node.services.vipstarcoind.height - block.height + 1;
    if (confirmations >= self.blockCacheConfirmations) {
      self.blockSummaryCache.set(hash, summary);
    }

    return finish(summary);
  });
};

// List blocks by date
BlockController.prototype.list = function (req, res) {
  var self = this;
  var todayStr = self.formatTimestamp(new Date());
  var dateStr = req.query.blockDate || todayStr;
  var isToday = dateStr === todayStr;
  var limit = Math.min(parseInt(req.query.limit || 10), BLOCK_LIMIT);
  var moreTimestamp = Math.floor(Date.now() / 1000);

  var tipHeight = self.node.services.vipstarcoind.height;
  if (!tipHeight || tipHeight < 0) {
    return self.common.handleErrors(new Error('Node not ready'), res);
  }

  // timestampindex 不要: 高さベースで最新 N ブロックを取得
  var heights = [];
  for (var h = tipHeight; h > tipHeight - limit && h >= 0; h--) {
    heights.push(h);
  }

  async.mapSeries(heights, function (height, callback) {
    self.node.services.vipstarcoind.getBlockHeader(height, function (err, info) {
      if (err) { return callback(err); }
      callback(null, info.hash);
    });
  }, function (err, hashes) {
    if (err) { return self.common.handleErrors(err, res); }

    async.mapSeries(hashes, function (hash, callback) {
      self._getBlockSummary(hash, moreTimestamp, callback);
    }, function (err, blocks) {
      if (err) { return self.common.handleErrors(err, res); }

      return res.jsonp({
        blocks: blocks,
        length: blocks.length,
        pagination: {
          next: null,
          prev: null,
          currentTs: moreTimestamp - 1,
          current: dateStr,
          isToday: isToday,
          more: false
        }
      });
    });
  });
};

//helper to convert timestamps to yyyy-mm-dd format
BlockController.prototype.formatTimestamp = function (date) {
    var yyyy = date.getUTCFullYear().toString();
    var mm = (date.getUTCMonth() + 1).toString(); // getMonth() is zero-based
    var dd = date.getUTCDate().toString();

    return yyyy + '-' + (mm[1] ? mm : '0' + mm[0]) + '-' + (dd[1] ? dd : '0' + dd[0]); //padding
};

module.exports = BlockController;
