'use strict';

var async = require('async');
var Common = require('../lib/common');

var TYPE = 'ADDRESS_TX';

/**
 * AddressTxService
 *
 * ブロックをスキャンして vout/vin のアドレスと txid の対応を
 * MongoDB に蓄積する。
 *
 * addressindex=1 が不要な代替実装。
 * AddressBalanceService と同じ polling パターンを採用。
 */
function AddressTxService(options) {
    this.common = new Common({ log: options.node.log });
    this.node = options.node;
    this.lastBlockRepository = options.lastBlockRepository;
    this.addressTxRepository = options.addressTxRepository;

    this.lastTipHeight = 0;
    this.lastTipInProcess = false;
    this.lastCheckedBlock = 0;
}

// ─────────────────────────────────────────────────────────────
// 起動
// ─────────────────────────────────────────────────────────────

AddressTxService.prototype.start = function (next) {
    var self = this;

    self.common.log.info('[AddressTxService] Start...');

    return async.waterfall([

        // 1. LastBlock レコードを初期化
        function (callback) {
            return self.lastBlockRepository.setLastBlockType(TYPE, 0, function (err) {
                if (err) {
                    self.common.log.error('[AddressTxService] setLastBlockType Error', err);
                    return callback(err);
                }
                self.common.log.info('[AddressTxService] LastBlockType set');
                return callback();
            });
        },

        // 2. 前回スキャン済みブロック高を取得
        function (callback) {
            return self.lastBlockRepository.getLastBlockByType(TYPE, function (err, existingType) {
                if (err) {
                    self.common.log.error('[AddressTxService] getLastBlockByType Error', err);
                    return callback(err);
                }
                self.lastCheckedBlock = existingType.last_block_number;
                self.common.log.info('[AddressTxService] lastCheckedBlock =', self.lastCheckedBlock);
                return callback();
            });
        },

        // 3. 現在のブロック高を取得
        function (callback) {
            return self.node.getInfo(function (err, data) {
                if (err) {
                    self.common.log.error('[AddressTxService] getInfo Error', err);
                    return callback(err);
                }
                if (data && data.blocks > self.lastTipHeight) {
                    self.lastTipHeight = data.blocks;
                }
                self.common.log.info('[AddressTxService] lastTipHeight =', self.lastTipHeight);
                return callback();
            });
        }

    ], function (err) {
        if (err) {
            self.common.log.error('[AddressTxService] start Error', err);
            return next(err);
        }

        // tip イベントを購読
        self.node.services.vipstarcoind.on('tip', self._rapidProtectedUpdateTip.bind(self));
        self._rapidProtectedUpdateTip(self.lastTipHeight);

        return next();
    });
};

// ─────────────────────────────────────────────────────────────
// スキャンループ
// ─────────────────────────────────────────────────────────────

AddressTxService.prototype._rapidProtectedUpdateTip = function (height) {
    var self = this;

    if (height > this.lastTipHeight) {
        this.lastTipHeight = height;
    }

    if (this.lastTipInProcess) {
        return false;
    }

    this.lastTipInProcess = true;

    self.common.log.info('[AddressTxService] scan from', self.lastCheckedBlock + 1, 'to', height);

    return this._processLastBlocks(height, function (err) {
        self.lastTipInProcess = false;

        if (err) {
            self.common.log.error('[AddressTxService] scan error', err);
            return false;
        }

        self.common.log.info('[AddressTxService] scanned to', height);

        if (self.lastTipHeight !== height) {
            self._rapidProtectedUpdateTip(self.lastTipHeight);
        }
    });
};

AddressTxService.prototype._processLastBlocks = function (height, next) {
    var self = this;
    var blocks = [];

    for (var i = self.lastCheckedBlock + 1; i <= height; i++) {
        blocks.push(i);
    }

    return async.eachSeries(blocks, function (blockHeight, callback) {
        return self.processBlock(blockHeight, function (err) {
            if (err) {
                // エラーは警告に留めてスキャンを継続
                self.common.log.warn('[AddressTxService] skip block', blockHeight, err.message || err);
            } else {
                self.lastCheckedBlock = blockHeight;
            }
            return callback();
        });
    }, function (err) {
        return next(err);
    });
};

// ─────────────────────────────────────────────────────────────
// ブロック処理
// ─────────────────────────────────────────────────────────────

/**
 * 1 ブロックを処理して address→txid を MongoDB に書き込む
 *
 * @param {Number} blockHeight
 * @param {Function} next
 */
AddressTxService.prototype.processBlock = function (blockHeight, next) {
    var self = this;

    return self.node.getBlockOverview(blockHeight, function (err, block) {
        if (err) return next(err);

        return async.eachSeries(block.txids, function (txid, callback) {
            return self._processTx(txid, block.height, block.time, callback);
        }, function (err) {
            if (err) return next(err);

            return self.lastBlockRepository.updateOrAddLastBlock(blockHeight, TYPE, function (err) {
                return next(err);
            });
        });
    });
};

/**
 * 1 トランザクションを処理
 * vout のアドレス（受信）と vin の前出力アドレス（送信）を記録する
 *
 * @param {String} txid
 * @param {Number} height
 * @param {Number} blockTime
 * @param {Function} callback
 */
AddressTxService.prototype._processTx = function (txid, height, blockTime, callback) {
    var self = this;

    return self.node.getDetailedTransaction(txid, function (err, transaction) {
        if (err) {
            self.common.log.warn('[AddressTxService] getDetailedTransaction failed:', txid, err.message || err);
            return callback();
        }

        // 関係するアドレスを重複なく収集
        var addrSet = {};

        // vout（受信側）
        if (transaction.outputs) {
            transaction.outputs.forEach(function (output) {
                if (output.address) {
                    addrSet[output.address] = true;
                }
            });
        }

        // vin（送信側）、コインベースは除く
        if (!transaction.coinbase && transaction.inputs) {
            transaction.inputs.forEach(function (input) {
                if (input.address) {
                    addrSet[input.address] = true;
                }
            });
        }

        var addresses = Object.keys(addrSet);

        if (!addresses.length) {
            return callback();
        }

        // 各アドレスと txid の対応を保存
        return async.eachLimit(addresses, 5, function (address, done) {
            return self.addressTxRepository.addTx({
                address: address,
                txid: txid,
                height: height,
                blockTime: blockTime
            }, done);
        }, callback);
    });
};

module.exports = AddressTxService;
