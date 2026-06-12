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

VipstarcoindNode.prototype.stop = function () {
  if (this._pollTimer) {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }
};

// ─────────────────────────────────────────────────────────────
// ステータス系
// ─────────────────────────────────────────────────────────────

VipstarcoindNode.prototype.getInfo = function (callback) {
  var self = this;

  // getinfo は Qtum 0.20.3 (Bitcoin Core 0.20 ベース) で廃止済み。
  // getblockchaininfo / getnetworkinfo / getwalletinfo を合成して互換レスポンスを返す。
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
    subsidy: function (done) {                              // ← 追加
      self.rpc.getSubsidy(self.height || 0, function (err, res) {
        done(null, (!err && res && res.result) ? res.result : 0);
      });
    }
  }, function (err, r) {
    if (err) return callback(err);

    var chain = r.chain || {};
    var net = r.network || {};
    var wallet = r.wallet || {};
    var blocks = chain.blocks || self.height || 0;

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

/**
 * hashOrHeight を受け取りブロックヘッダー情報を返す
 * lib/blocks.js, lib/status.js 等で使用
 */
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

/**
 * bitcore.Block オブジェクトを返す
 * lib/blocks.js getBlockByHash(), services/StatisticService.js 等で使用
 */
VipstarcoindNode.prototype.getBlock = function (hashOrHeight, callback) {
  var self = this;

  function _fetch(hash) {
    // verbose=false → raw hex, bitcore でパース
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

/**
 * raw ブロックを Buffer で返す
 * lib/blocks.js rawBlock() で使用
 */
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

/**
 * ブロック概要（txids 付き）を返す
 * lib/transactions.js, services/AddressBalanceService.js, lib/erc20-watcher.js 等で使用
 */
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
        flags: b.flags || 0   // Qtum: PoS=2 / PoW=1
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

/**
 * JSON 形式のブロックをそのまま返す
 * services/*.js の processBlock() 等で使用
 */
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

/**
 * タイムスタンプ範囲でブロックハッシュを返す
 * lib/blocks.js list() で使用 (timestampindex=1 が必要)
 */
VipstarcoindNode.prototype.getBlockHashesByTimestamp = function (high, low, callback) {
  this.rpc.getBlockHashes(high, low, { logTimestamps: false }, function (err, res) {
    if (err) return callback(err);
    callback(null, res.result || []);
  });
};

/**
 * ブロック報酬 (satoshis)
 * lib/blocks.js, services/StatisticService.js で使用
 */
VipstarcoindNode.prototype.getSubsidy = function (height, callback) {
  this.rpc.getSubsidy(height, function (err, res) {
    if (err) {
      // RPC未実装の場合は固定値で逃げる
      return callback(null, 400000000); // 4 VIPS
    }
    callback(null, res.result);
  });
};

// ─────────────────────────────────────────────────────────────
// トランザクション系
// ─────────────────────────────────────────────────────────────

/**
 * 詳細なトランザクション情報を返す（最も重要なメソッド）
 *
 * 返す構造は vipstarcoincore-node の getDetailedTransaction 互換。
 *
 * 修正点：
 * - getrawtransaction に height フィールドがない場合、blockhash からブロックヘッダーを取得
 * - spentindex が vin に値を付けない場合（PoS 等）、前の tx をフェッチして補完
 */
VipstarcoindNode.prototype.getDetailedTransaction = function (txid, callback) {
  var self = this;

  self.rpc.getRawTransaction(txid, 1, function (err, res) {
    if (err) return callback(err);
    if (!res || !res.result) return callback(new Error('Transaction not found: ' + txid));

    var tx = res.result;
    var coinbase = !!(tx.vin && tx.vin.length && tx.vin[0].coinbase);

    // vout マッピング（先に確定）
    var outputs = (tx.vout || []).map(function (vout) {
      var spk = vout.scriptPubKey || {};
      var addr = null;
      if (spk.addresses && spk.addresses.length) {
        addr = spk.addresses[0];
      } else if (spk.address) {
        addr = spk.address;
      }
      return {
        address: addr,
        satoshis: Math.round((vout.value || 0) * 1e8),
        script: spk.hex || '',
        scriptAsm: spk.asm || '',
        spentTxId: vout.spentTxId || null,
        spentIndex: vout.spentIndex !== undefined ? vout.spentIndex : null,
        spentHeight: vout.spentHeight || null
      };
    });

    // ── vin の address/value 補完 ──────────────────────────────
    // spentindex=1 が vin に値を付けない場合（PoS coinstake 等）、
    // 前の tx を取得して補完する
    function resolveInputs(done) {
      if (coinbase) {
        return done(null, [{ script: tx.vin[0].coinbase, sequence: tx.vin[0].sequence, satoshis: 0 }]);
      }

      var vins = tx.vin || [];
      // spentindex が全 vin に値を付けているか確認
      var needsLookup = vins.some(function (v) {
        return v.value === undefined && v.address === undefined;
      });

      if (!needsLookup) {
        // spentindex データがあればそのまま使う
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
      async.map(vins, function (vin, next) {
        self.rpc.getRawTransaction(vin.txid, 1, function (e, prevRes) {
          var addr = null;
          var sat = 0;
          if (!e && prevRes && prevRes.result) {
            var prevOut = prevRes.result.vout[vin.vout];
            if (prevOut) {
              sat = Math.round((prevOut.value || 0) * 1e8);
              var spk = prevOut.scriptPubKey || {};
              if (spk.addresses && spk.addresses.length) addr = spk.addresses[0];
              else if (spk.address) addr = spk.address;
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
    // getrawtransaction に height フィールドがない場合、blockhash → getblockheader
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

/**
 * bitcore.Transaction オブジェクトを返す
 * lib/transactions.js rawTransaction() で使用
 */
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

/**
 * JSON 形式の生トランザクション
 * services/AddressBalanceService.js, lib/erc20-watcher.js で使用
 */
VipstarcoindNode.prototype.getJsonRawTransaction = function (txid, callback) {
  this.rpc.getRawTransaction(txid, 1, function (err, res) {
    if (err) return callback(err);
    if (!res || !res.result) return callback(new Error('Transaction not found: ' + txid));
    callback(null, res.result);
  });
};

/**
 * EVM トランザクションレシート（Qtum/VIPS 固有）
 * lib/transactions.js, services/TransactionService.js で使用
 */
VipstarcoindNode.prototype.getTransactionReceipt = function (txid, callback) {
  this.rpc.getTransactionReceipt(txid, function (err, res) {
    if (err) return callback(null, []);  // 通常 tx はレシートなし
    callback(null, res.result || []);
  });
};

/**
 * raw tx を broadcast
 * lib/transactions.js send() で使用
 */
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
// アドレス系（addressindex=1, spentindex=1 が必要）
// ─────────────────────────────────────────────────────────────

/**
 * アドレスサマリー
 * lib/addresses.js getAddressSummary() で使用
 */
VipstarcoindNode.prototype.getAddressSummary = function (address, options, callback) {
  var self = this;
  var addrs = Array.isArray(address) ? address : [address];
  options = options || {};

  async.parallel({
    balance: function (done) {
      // MongoDB 経由（デーモンに addressindex がないため）
      self.getAddressBalance(addrs, {}, function (err, result) {
        if (err) return done(err);
        done(null, { balance: result.balance || 0, received: result.received || 0 });
      });
    },
    txids: function (done) {
      if (options.noTxList) return done(null, []);
      self.rpc.getAddressTxids({ addresses: addrs }, function (err, res) {
        done(null, (err || !res) ? [] : (res.result || []));
      });
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

    // from/to ページネーション
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

/**
 * リポジトリを注入する（lib/index.js のコンストラクタから呼ぶ）
 * デーモンに addressindex がないため、MongoDB で代替する
 */
VipstarcoindNode.prototype.setAddressBalanceRepository = function (repo) {
  this._addressBalanceRepository = repo;
};

/**
 * アドレス残高（MongoDB から取得）
 * services/AddressBalanceService.js, lib/addresses.js で使用
 */
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
    // MongoDB は VIPS 単位、呼び出し元は satoshi を期待
    var balanceSat = Math.round((balanceVips || 0) * 1e8);
    callback(null, { balance: balanceSat, received: 0, immature: 0 });
  });
};

/**
 * メモリプール内のアドレス残高
 * lib/addresses.js balancesum() で使用
 */
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

/**
 * UTXO 一覧
 * lib/addresses.js utxo() / multiutxo() / utxoWithoutMempool() で使用
 */
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
 * トランザクション履歴（ページネーション付き）
 * lib/addresses.js multitxs(), lib/transactions.js list() で使用
 *
 * NOTE: 各 tx の詳細取得が必要なため、履歴が長いアドレスでは遅くなる。
 *       大量アドレス対応は将来の課題（getAddressDeltasを使うとより効率的）。
 */
VipstarcoindNode.prototype.getAddressHistory = function (addresses, options, callback) {
  var self = this;
  var addrs = Array.isArray(addresses) ? addresses : [addresses];
  options = options || {};

  var from = options.from || 0;
  var to = options.to || 10;

  self.rpc.getAddressTxids({ addresses: addrs }, function (err, res) {
    if (err) return callback(err);

    var allTxids = (res.result || []).reverse(); // 最新順
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
};

/**
 * listunspent ラッパー
 * lib/addresses.js listUnspent() で使用
 */
VipstarcoindNode.prototype.listUnspent = function (minConf, maxConf, addresses, callback) {
  this.rpc.listUnspent(minConf, maxConf, addresses, function (err, res) {
    if (err) return callback(err);
    callback(null, res.result || []);
  });
};

/**
 * 新アドレス生成
 * lib/addresses.js createaddress() で使用
 */
VipstarcoindNode.prototype.getNewAddress = function (callback) {
  this.rpc.getNewAddress(function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

// ─────────────────────────────────────────────────────────────
// コントラクト系（Qtum/VIPS 固有）
// ─────────────────────────────────────────────────────────────

/**
 * コントラクト呼び出し（読み取り専用）
 * lib/contracts.js, lib/erc20-watcher.js で使用
 *
 * Qtum RPC: callcontract "address" "data" ["senderAddress"] [gasLimit]
 */
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

/**
 * コントラクトアカウント情報
 * lib/contracts.js getAccountInfo() で使用
 */
VipstarcoindNode.prototype.getAccountInfo = function (address, callback) {
  this.rpc.getAccountInfo(address, function (err, res) {
    if (err) return callback(err);
    callback(null, res.result);
  });
};

module.exports = VipstarcoindNode;
