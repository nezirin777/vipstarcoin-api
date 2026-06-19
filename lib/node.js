'use strict';

/**
 * VipstarcoindNode
 *
 * vipstarcoincore-node の代替シム。
 * vipstarcoind-rpc を薄く包み、既存コードが期待する
 * node.* / node.services.vipstarcoind.* インターフェースを提供する。
 *
 * 既存コードは一切変更不要。
 */

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var async = require('async');
var bitcore = require('vipstarcoin-lib');
var RpcClient = require('vipstarcoind-rpc');

var POLL_INTERVAL_MS = 5000;

// ─────────────────────────────────────────────────────────────
// コンストラクタ
// ─────────────────────────────────────────────────────────────

/**
 * @param {Object} options
 * @param {Object} options.rpc        - RPC 接続設定
 * @param {String} options.rpc.host
 * @param {Number} options.rpc.port
 * @param {String} options.rpc.user
 * @param {String} options.rpc.pass
 * @param {Object} [options.log]      - { info, warn, error } インターフェース
 */
function VipstarcoindNode(options) {
  EventEmitter.call(this);

  options = options || {};

  // ロガー（なければ console で代用）
  this.log = options.log || {
    info: function () { console.log.apply(console, arguments); },
    warn: function () { console.warn.apply(console, arguments); },
    error: function () { console.error.apply(console, arguments); }
  };

  // RPC クライアント
  var rpcOpts = options.rpc || {};
  this.rpc = new RpcClient({
    protocol: rpcOpts.protocol || 'http',
    host: rpcOpts.host || '127.0.0.1',
    port: rpcOpts.port || 31916,
    user: rpcOpts.user || 'user',
    pass: rpcOpts.pass || 'pass'
  });

  // ネットワーク（vipstarcoin-lib の livenet = VIPS mainnet, pubkeyhash=0x46）
  this.network = bitcore.Networks.livenet;

  // ブロック高・tip ハッシュ（ポーリングで更新）
  this.height = 0;
  this.tiphash = null;

  // ── 互換性エイリアス ──────────────────────────────────────
  // 既存コードが node.services.vipstarcoind.xxx を呼ぶため self を差す
  this.services = { vipstarcoind: this };

  // lib/blocks.js が node.services.vipstarcoind.client.getBlock を直接呼ぶ
  this.client = this.rpc;

  this._pollTimer = null;
  this._initState();
}

util.inherits(VipstarcoindNode, EventEmitter);

// ─────────────────────────────────────────────────────────────
// ポーリング
// ─────────────────────────────────────────────────────────────

VipstarcoindNode.prototype._initState = function () {
  var self = this;

  // 起動時に初期高を取得してからポーリング開始
  self.rpc.getBlockCount(function (err, res) {
    if (!err && res && res.result !== undefined) {
      self.height = res.result;
    }
    self.rpc.getBestBlockHash(function (err2, res2) {
      if (!err2 && res2 && res2.result) {
        self.tiphash = res2.result;
      }
      self._startPolling();
    });
  });
};

VipstarcoindNode.prototype._startPolling = function () {
  var self = this;
  // メモリプールのポーリング監視を開始
  self._startMempoolPolling();

  self._pollTimer = setInterval(function () {
    self.rpc.getBestBlockHash(function (err, res) {
      if (err || !res || !res.result) return;

      var newHash = res.result;
      if (newHash === self.tiphash) return;  // 変化なし

      self.rpc.getBlockCount(function (err2, res2) {
        if (err2 || !res2 || res2.result === undefined) return;

        var newHeight = res2.result;
        self.tiphash = newHash;
        self.height = newHeight;

        self.log.info('[VipstarcoindNode] new tip height=' + newHeight +
          ' hash=' + newHash.slice(0, 16) + '...');

        // 既存 services が購読しているイベント
        self.emit('tip', newHeight);
        self.emit('block', Buffer.from(newHash, 'hex'));
      });
    });
  }, POLL_INTERVAL_MS);
};

VipstarcoindNode.prototype._startMempoolPolling = function () {
  var self = this;
  self._mempoolCache = {};

  self.log.info('[VipstarcoindNode] Starting mempool polling...');

  self.rpc.getRawMemPool(function (err, res) {
    if (err) {
      self.log.error('[VipstarcoindNode] Error initializing mempool:', err);
      return;
    }
    if (res && res.result) {
      var initialTxs = res.result || [];
      self.log.info('[VipstarcoindNode] Initialized mempool cache with ' + initialTxs.length + ' txs');
      initialTxs.forEach(function (txid) {
        self._mempoolCache[txid] = true;
      });
    }
  });

  self._mempoolTimer = setInterval(function () {
    self.rpc.getRawMemPool(function (err, res) {
      if (err) {
        self.log.error('[VipstarcoindNode] Mempool poll error:', err);
        return;
      }
      if (!res || !res.result) return;

      var currentTxs = res.result || [];
      var newTxs = [];

      currentTxs.forEach(function (txid) {
        if (!self._mempoolCache[txid]) {
          newTxs.push(txid);
        }
      });

      // キャッシュ更新（メモリリーク防止）
      var nextCache = {};
      currentTxs.forEach(function (txid) {
        nextCache[txid] = true;
      });
      self._mempoolCache = nextCache;

      if (newTxs.length > 0) {
        self.log.info('[VipstarcoindNode] Detected ' + newTxs.length + ' new mempool txs');
        async.eachLimit(newTxs, 2, function (txid, done) {
          self.rpc.getRawTransaction(txid, false, function (err2, txRes) {
            if (err2) {
              self.log.error('[VipstarcoindNode] Error fetching raw tx ' + txid + ':', err2);
              return done();
            }
            if (txRes && txRes.result) {
              var rawHex = txRes.result;
              self.emit('tx', Buffer.from(rawHex, 'hex'));
            }
            done();
          });
        }, function () {
          // 処理完了
        });
      }
    });
  }, 3000);
};

VipstarcoindNode.prototype.stop = function () {
  if (this._pollTimer) {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }
  if (this._mempoolTimer) {
    clearInterval(this._mempoolTimer);
    this._mempoolTimer = null;
  }
};

// ─────────────────────────────────────────────────────────────
// ステータス系
// ─────────────────────────────────────────────────────────────

VipstarcoindNode.prototype.getInfo = function (callback) {
  var self = this;

  async.parallel({
    chain: function (done) {
      self.rpc.getBlockchainInfo(function (err, res) {
        done(null, (!err && res) ? res.result : {});
      });
    },
    network: function (done) {
      self.rpc.getNetworkInfo(function (err, res) {
        done(null, (!err && res) ? res.result : {});
      });
    },
    wallet: function (done) {
      self.rpc.getWalletInfo(function (err, res) {
        done(null, (!err && res) ? res.result : {});
      });
    },
    subsidy: function (done) {
      self.rpc.getSubsidy(self.height || 0, function (err, res) {
        done(null, (!err && res && res.result) ? res.result : 0);
      });
    }
  }, function (err, r) {
    if (err) return callback(err);

    var chain = r.chain || {};
    var net = r.network || {};
    var wallet = r.wallet || {};

    callback(null, {
      version: net.version || 0,
      protocolVersion: net.protocolversion || 0,
      walletversion: wallet.walletversion || 0,
      balance: wallet.balance || 0,
      blocks: chain.blocks || self.height,
      timeOffset: net.timeoffset || 0,
      connections: net.connections || 0,
      proxy: '',
      difficulty: chain.difficulty || 0,
      testnet: chain.chain === 'test',
      keypoololdest: wallet.keypoololdest || 0,
      keypoolsize: wallet.keypoolsize || 0,
      paytxfee: wallet.paytxfee || 0,
      relayFee: net.relayfee || 0,
      errors: '',
      network: chain.chain || 'main',
      reward: r.subsidy || 0,
      moneysupply: chain.moneysupply || 0
    });
  });
};

VipstarcoindNode.prototype.getBestBlockHash = function (callback) {
  this.rpc.getBestBlockHash(function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

VipstarcoindNode.prototype.getMiningInfo = function (callback) {
  this.rpc.getMiningInfo(function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

VipstarcoindNode.prototype.getStakingInfo = function (callback) {
  this.rpc.getStakingInfo(function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

VipstarcoindNode.prototype.getDgpInfo = function (callback) {
  this.rpc.getDgpInfo(function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

VipstarcoindNode.prototype.isSynced = function (callback) {
  this.rpc.getBlockchainInfo(function (err, res) {
    if (err) return callback(err);
    callback(null, (res.result.verificationprogress || 0) >= 0.9999);
  });
};

VipstarcoindNode.prototype.syncPercentage = function (callback) {
  this.rpc.getBlockchainInfo(function (err, res) {
    if (err) return callback(err);
    callback(null, Math.min((res.result.verificationprogress || 0) * 100, 100));
  });
};

VipstarcoindNode.prototype.estimateFee = function (nBlocks, callback) {
  this.rpc.estimateFee(nBlocks, function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

// ─────────────────────────────────────────────────────────────
// ブロック系
// ─────────────────────────────────────────────────────────────

VipstarcoindNode.prototype.getBlockHash = function (height, callback) {
  this.rpc.getBlockHash(height, function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

VipstarcoindNode.prototype.getBlockHeader = function (hashOrHeight, callback) {
  var self = this;

  function _fetch(hash) {
    self.rpc.getBlockHeader(hash, true, function (err, res) {
      if (err) return callback(err);
      var h = res.result;
      callback(null, {
        hash: h.hash,
        version: h.version,
        prevHash: h.previousblockhash || null,
        nextHash: h.nextblockhash || null,
        merkleRoot: h.merkleroot,
        time: h.time,
        nonce: h.nonce,
        bits: h.bits,
        difficulty: h.difficulty,
        chainWork: h.chainwork,
        height: h.height,
        confirmations: h.confirmations
      });
    });
  }

  if (typeof hashOrHeight === 'number') {
    self.getBlockHash(hashOrHeight, function (err, hash) {
      if (err) return callback(err);
      _fetch(hash);
    });
  } else {
    _fetch(hashOrHeight);
  }
};

VipstarcoindNode.prototype.getBlock = function (hashOrHeight, callback) {
  var self = this;

  function _fetch(hash) {
    self.rpc.getBlock(hash, false, function (err, res) {
      if (err) return callback(err);
      if (!res || !res.result) return callback(new Error('Block not found: ' + hash));
      try {
        callback(null, bitcore.Block.fromBuffer(Buffer.from(res.result, 'hex')));
      } catch (e) {
        callback(e);
      }
    });
  }

  if (typeof hashOrHeight === 'number') {
    self.getBlockHash(hashOrHeight, function (err, hash) {
      if (err) return callback(err);
      _fetch(hash);
    });
  } else {
    _fetch(hashOrHeight);
  }
};

VipstarcoindNode.prototype.getRawBlock = function (hashOrHeight, callback) {
  var self = this;

  function _fetch(hash) {
    self.rpc.getBlock(hash, false, function (err, res) {
      if (err) return callback(err);
      if (!res || !res.result) return callback(new Error('Block not found'));
      callback(null, Buffer.from(res.result, 'hex'));
    });
  }

  if (typeof hashOrHeight === 'number') {
    self.getBlockHash(hashOrHeight, function (err, hash) {
      if (err) return callback(err);
      _fetch(hash);
    });
  } else {
    _fetch(hashOrHeight);
  }
};

VipstarcoindNode.prototype.getBlockOverview = function (hashOrHeight, callback) {
  var self = this;

  function _fetch(hash) {
    self.rpc.getBlock(hash, true, function (err, res) {
      if (err) return callback(err);
      if (!res || !res.result) return callback(new Error('Block not found'));
      var b = res.result;
      callback(null, {
        hash: b.hash,
        height: b.height,
        chainWork: b.chainwork,
        prevHash: b.previousblockhash || null,
        nextHash: b.nextblockhash || null,
        confirmations: b.confirmations,
        txids: b.tx,
        time: b.time,
        flags: b.flags || 0
      });
    });
  }

  if (typeof hashOrHeight === 'number') {
    self.getBlockHash(hashOrHeight, function (err, hash) {
      if (err) return callback(err);
      _fetch(hash);
    });
  } else {
    _fetch(hashOrHeight);
  }
};

VipstarcoindNode.prototype.getJsonBlock = function (hashOrHeight, callback) {
  var self = this;

  function _fetch(hash) {
    self.rpc.getBlock(hash, true, function (err, res) {
      if (err) return callback(err);
      if (!res || !res.result) return callback(new Error('Block not found'));
      callback(null, res.result);
    });
  }

  if (typeof hashOrHeight === 'number') {
    self.getBlockHash(hashOrHeight, function (err, hash) {
      if (err) return callback(err);
      _fetch(hash);
    });
  } else {
    _fetch(hashOrHeight);
  }
};

VipstarcoindNode.prototype.getBlockHashesByTimestamp = function (high, low, callback) {
  this.rpc.getBlockHashes(high, low, { logTimestamps: false }, function (err, res) {
    if (err) return callback(err);
    callback(null, res.result || []);
  });
};

VipstarcoindNode.prototype.getSubsidy = function (height, callback) {
  this.rpc.getSubsidy(height, function (err, res) {
    if (err) {
      return callback(null, 400000000); // 4 VIPS
    }
    callback(null, res.result);
  });
};

// ─────────────────────────────────────────────────────────────
// トランザクション系
// ─────────────────────────────────────────────────────────────

/**
 * P2PK スクリプトから VIPS アドレスに変換するヘルパー
 * @param {Object} spk - scriptPubKey オブジェクト
 * @returns {String|null} アドレス文字列、変換できなければ null
 */
function _resolveAddressFromSpk(spk) {
  if (!spk) return null;

  // P2PKH / P2SH: addresses フィールドあり
  if (spk.addresses && spk.addresses.length) {
    return spk.addresses[0];
  }
  if (spk.address) {
    return spk.address;
  }

  // P2PK: type='pubkey', addresses フィールドなし → bitcore で変換
  if (spk.type === 'pubkey' && spk.hex) {
    try {
      var script = new bitcore.Script(Buffer.from(spk.hex, 'hex'));
      if (script.isPublicKeyOut()) {
        var pubkey = new bitcore.PublicKey(script.chunks[0].buf);
        return new bitcore.Address(pubkey, bitcore.Networks.livenet).toString();
      }
    } catch (e) {
      // 変換失敗は無視
    }
  }

  return null;
}

/**
 * 詳細なトランザクション情報を返す（最も重要なメソッド）
 *
 * 変更点（Phase 3.5）:
 * - P2PK → Address 変換を fallback 処理に追加（_resolveAddressFromSpk を使用）
 */
VipstarcoindNode.prototype.getDetailedTransaction = function (txid, callback) {
  var self = this;

  self.rpc.getRawTransaction(txid, 1, function (err, res) {
    if (err) return callback(err);
    if (!res || !res.result) return callback(new Error('Transaction not found: ' + txid));

    var tx = res.result;
    var coinbase = !!(tx.vin && tx.vin.length && tx.vin[0].coinbase);

    // vout マッピング
    var outputs = (tx.vout || []).map(function (vout) {
      var spk = vout.scriptPubKey || {};
      return {
        address: _resolveAddressFromSpk(spk),
        satoshis: Math.round((vout.value || 0) * 1e8),
        script: spk.hex || '',
        scriptAsm: spk.asm || '',
        spentTxId: vout.spentTxId || null,
        spentIndex: vout.spentIndex !== undefined ? vout.spentIndex : null,
        spentHeight: vout.spentHeight || null
      };
    });

    // ── vin の address/value 補完 ──────────────────────────────
    function resolveInputs(done) {
      if (coinbase) {
        return done(null, [{ script: tx.vin[0].coinbase, sequence: tx.vin[0].sequence, satoshis: 0 }]);
      }

      var vins = tx.vin || [];
      var needsLookup = vins.some(function (v) {
        return v.value === undefined && v.address === undefined;
      });

      if (!needsLookup) {
        return done(null, vins.map(function (vin) {
          return {
            address: vin.address || null,
            prevTxId: vin.txid,
            outputIndex: vin.vout,
            sequence: vin.sequence,
            script: vin.scriptSig ? vin.scriptSig.hex : '',
            scriptAsm: vin.scriptSig ? vin.scriptSig.asm : '',
            satoshis: vin.value !== undefined ? Math.round(vin.value * 1e8) : 0
          };
        }));
      }

      // フォールバック: 前の tx を取得して address/value を補完
      // P2PKH / P2PK 両対応（_resolveAddressFromSpk を使用）
      async.map(vins, function (vin, next) {
        self.rpc.getRawTransaction(vin.txid, 1, function (e, prevRes) {
          var addr = null;
          var sat = 0;
          if (!e && prevRes && prevRes.result) {
            var prevOut = prevRes.result.vout[vin.vout];
            if (prevOut) {
              sat = Math.round((prevOut.value || 0) * 1e8);
              addr = _resolveAddressFromSpk(prevOut.scriptPubKey);
            }
          }
          next(null, {
            address: addr,
            prevTxId: vin.txid,
            outputIndex: vin.vout,
            sequence: vin.sequence,
            script: vin.scriptSig ? vin.scriptSig.hex : '',
            scriptAsm: vin.scriptSig ? vin.scriptSig.asm : '',
            satoshis: sat
          });
        });
      }, done);
    }

    // ── blockheight 取得 ─────────────────────────────────────────
    function resolveHeight(done) {
      if (tx.height !== undefined) return done(null, tx.height);
      if (!tx.blockhash) return done(null, -1);

      self.rpc.getBlockHeader(tx.blockhash, true, function (e, hRes) {
        done(null, (!e && hRes && hRes.result) ? hRes.result.height : -1);
      });
    }

    async.parallel({ inputs: resolveInputs, height: resolveHeight }, function (err, r) {
      if (err) return callback(err);

      var inputs = r.inputs;
      var height = r.height;
      var inputSatoshis = coinbase ? 0 : inputs.reduce(function (s, i) { return s + (i.satoshis || 0); }, 0);
      var outputSatoshis = outputs.reduce(function (s, o) { return s + o.satoshis; }, 0);

      callback(null, {
        hash: tx.txid,
        version: tx.version,
        hex: tx.hex || '',
        blockHash: tx.blockhash || null,
        height: height,
        blockTimestamp: tx.blocktime || null,
        receivedTime: tx.time || null,
        coinbase: coinbase,
        locktime: tx.locktime,
        inputSatoshis: inputSatoshis,
        outputSatoshis: outputSatoshis,
        feeSatoshis: coinbase ? 0 : Math.max(0, inputSatoshis - outputSatoshis),
        inputs: inputs,
        outputs: outputs
      });
    });
  });
};

VipstarcoindNode.prototype.getTransaction = function (txid, callback) {
  this.rpc.getRawTransaction(txid, false, function (err, res) {
    if (err) return callback(err);
    if (!res || !res.result) return callback(new Error('Transaction not found: ' + txid));
    try {
      callback(null, new bitcore.Transaction(res.result));
    } catch (e) {
      callback(e);
    }
  });
};

VipstarcoindNode.prototype.getJsonRawTransaction = function (txid, callback) {
  this.rpc.getRawTransaction(txid, 1, function (err, res) {
    if (err) return callback(err);
    if (!res || !res.result) return callback(new Error('Transaction not found: ' + txid));
    callback(null, res.result);
  });
};

VipstarcoindNode.prototype.getTransactionReceipt = function (txid, callback) {
  this.rpc.getTransactionReceipt(txid, function (err, res) {
    if (err) return callback(null, []);
    callback(null, res.result || []);
  });
};

VipstarcoindNode.prototype.sendTransaction = function (rawtx, options, callback) {
  if (typeof options === 'function') {
    callback = options;
  }
  this.rpc.sendRawTransaction(rawtx, function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

// ─────────────────────────────────────────────────────────────
// アドレス系
// ─────────────────────────────────────────────────────────────

VipstarcoindNode.prototype.getAddressSummary = function (address, options, callback) {
  var self = this;
  var addrs = Array.isArray(address) ? address : [address];
  options = options || {};

  async.parallel({
    balance: function (done) {
      self.getAddressBalance(addrs, {}, function (err, result) {
        if (err) return done(err);
        done(null, { balance: result.balance || 0, received: result.received || 0 });
      });
    },
    txids: function (done) {
      if (options.noTxList) return done(null, []);
      // MongoDB から取得（AddressTxRepository 経由）
      if (self._addressTxRepository) {
        self._addressTxRepository.getTxidsByAddress(addrs[0], function (err, txids) {
          done(null, err ? [] : txids);
        });
      } else {
        done(null, []);
      }
    },
    mempool: function (done) {
      self.rpc.getAddressMempool({ addresses: addrs }, function (err, res) {
        if (err || !res) return done(null, { balance: 0, appearances: 0 });
        var items = res.result || [];
        var unconfirmedBalance = items.reduce(function (s, i) { return s + (i.satoshis || 0); }, 0);
        done(null, { balance: unconfirmedBalance, appearances: items.length });
      });
    }
  }, function (err, r) {
    if (err) return callback(err);

    var allTxids = r.txids;
    var paged = allTxids;

    if (options.from !== undefined && options.to !== undefined) {
      paged = allTxids.slice(options.from, options.to);
    }

    callback(null, {
      balance: r.balance.balance || 0,
      totalReceived: r.balance.received || 0,
      totalSpent: (r.balance.received || 0) - (r.balance.balance || 0),
      unconfirmedBalance: r.mempool.balance || 0,
      appearances: allTxids.length,
      unconfirmedAppearances: r.mempool.appearances || 0,
      txids: paged,
      immature: 0
    });
  });
};

VipstarcoindNode.prototype.setAddressBalanceRepository = function (repo) {
  this._addressBalanceRepository = repo;
};

/**
 * AddressTxRepository を注入する（lib/index.js から呼ぶ）
 * Phase 3.5 追加
 */
VipstarcoindNode.prototype.setAddressTxRepository = function (repo) {
  this._addressTxRepository = repo;
};

VipstarcoindNode.prototype.getAddressBalance = function (addresses, options, callback) {
  if (typeof options === 'function') { callback = options; }
  var addrs = Array.isArray(addresses) ? addresses : [addresses];
  var addr = addrs[0];
  var repo = this._addressBalanceRepository;

  if (!repo) {
    return callback(null, { balance: 0, received: 0, immature: 0 });
  }

  repo.getBalanceByAddress(addr, function (err, balanceVips) {
    if (err) return callback(err);
    var balanceSat = Math.round((balanceVips || 0) * 1e8);
    callback(null, { balance: balanceSat, received: 0, immature: 0 });
  });
};

VipstarcoindNode.prototype.getAddressesMempoolBalance = function (addresses, options, callback) {
  if (typeof options === 'function') { callback = options; }
  var addrs = Array.isArray(addresses) ? addresses : [addresses];

  this.rpc.getAddressMempool({ addresses: addrs }, function (err, res) {
    if (err || !res) return callback(null, { unconfirmedBalance: 0 });
    var items = res.result || [];
    var unconfirmedBalance = items.reduce(function (s, i) { return s + (i.satoshis || 0); }, 0);
    callback(null, { unconfirmedBalance: unconfirmedBalance });
  });
};

VipstarcoindNode.prototype.getAddressUnspentOutputs = function (addresses, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  var addrs = Array.isArray(addresses) ? addresses : [addresses];

  this.rpc.getAddressUtxos({ addresses: addrs }, function (err, res) {
    if (err) return callback(err);
    var utxos = (res.result || []).map(function (u) {
      return {
        address: u.address,
        txid: u.txid,
        outputIndex: u.outputIndex,
        script: u.script,
        satoshis: u.satoshis,
        height: u.height,
        timestamp: u.timestamp || null,
        isCoinBase: u.isCoinBase || false,
        isStake: u.isStake || false
      };
    });
    callback(null, utxos);
  });
};

/**
 * アドレス取引履歴（MongoDB から取得）
 * Phase 3.5: AddressTxRepository 経由で txid リストを取得してから詳細を返す
 */
VipstarcoindNode.prototype.getAddressHistory = function (addresses, options, callback) {
  var self = this;
  var addrs = Array.isArray(addresses) ? addresses : [addresses];
  options = options || {};

  var from = options.from || 0;
  var to = options.to || 10;

  // AddressTxRepository が注入されていれば MongoDB から取得
  if (self._addressTxRepository) {
    return self._addressTxRepository.getTxidsByAddress(addrs[0], function (err, allTxids) {
      if (err) return callback(err);

      var totalCount = allTxids.length;
      var selected = allTxids.slice(from, to);

      async.mapSeries(selected, function (txid, done) {
        self.getDetailedTransaction(txid, function (err, tx) {
          if (err) return done(err);
          done(null, { tx: tx, address: addrs[0] });
        });
      }, function (err, items) {
        if (err) return callback(err);
        callback(null, { totalCount: totalCount, items: items });
      });
    });
  }

  // フォールバック: 空を返す（スキャナー未起動時）
  callback(null, { totalCount: 0, items: [] });
};

VipstarcoindNode.prototype.listUnspent = function (minConf, maxConf, addresses, callback) {
  this.rpc.listUnspent(minConf, maxConf, addresses, function (err, res) {
    if (err) return callback(err);
    callback(null, res.result || []);
  });
};

VipstarcoindNode.prototype.getNewAddress = function (callback) {
  this.rpc.getNewAddress(function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

// ─────────────────────────────────────────────────────────────
// コントラクト系（Qtum/VIPS 固有）
// ─────────────────────────────────────────────────────────────

VipstarcoindNode.prototype.callContract = function (address, data, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  options = options || {};

  var from = options.from || '';
  var gasLimit = options.gasLimit || 250000;

  this.rpc.callContract(address, data, from, gasLimit, function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

VipstarcoindNode.prototype.getAccountInfo = function (address, callback) {
  this.rpc.getAccountInfo(address, function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

module.exports = VipstarcoindNode;
