# Phase 2 – 既存ファイルへの変更ガイド

新規ファイル（lib/node.js, server.js, package.json）以外に
最小限の変更が必要なファイルをまとめる。

---

## 1. lib/index.js
### 変更箇所：2行のみ

```diff
- InsightAPI.dependencies = ['vipstarcoind', 'web'];
+ InsightAPI.dependencies = [];
```

vipstarcoincore-node が読み込む設定値。スタンドアロン動作には不要。

---

## 2. components/Db.js
### 変更箇所：mongoose v5 への対応

```diff
- return mongoose.connect(url, { useMongoClient: true }, function (err) {
+ return mongoose.connect(url, { useNewUrlParser: true, useUnifiedTopology: true }, function (err) {
```

mongoose v4 の `useMongoClient` は v5 で廃止。
代わりに `useNewUrlParser` と `useUnifiedTopology` を指定する。

---

## 3. lib/blocks.js（任意・動作確認後に対応）
### 変更箇所：LRU キャッシュの初期化

現在のコード：
```javascript
this.blockSummaryCache = LRU(options.blockSummaryCacheSize || ...);
this.blockCache        = LRU(options.blockCacheSize        || ...);
```

lru-cache v4 では `LRU(number)` が有効なので現状のままで動く。
v5+ に上げる場合は `new LRU({max: n})` に変更が必要。

---

## 変更不要なファイル（そのまま利用可能）

| ファイル | 理由 |
|---|---|
| lib/blocks.js | node.* / node.services.vipstarcoind.* を使うが、lib/node.js が互換実装 |
| lib/transactions.js | 同上 |
| lib/addresses.js | 同上 |
| lib/status.js | 同上 |
| lib/erc20.js | 同上 |
| lib/erc20-watcher.js | 同上 |
| lib/statistics.js | 同上 |
| lib/contracts.js | 同上 |
| lib/messages.js | 同上 |
| lib/utils.js | 同上 |
| lib/currency.js | 同上 |
| lib/markets.js | 同上 |
| lib/ratelimiter.js | 外部依存なし |
| lib/common.js | 外部依存なし |
| lib/service.js | 外部依存なし（BaseService はローカル） |
| services/*.js | node.* 経由のみ |
| repositories/*.js | mongoose のみ |
| models/*.js | mongoose のみ |
| helpers/*.js | 外部依存なし |
| components/errors/*.js | 外部依存なし |

---

## 動作に必要な vipstarcoin.conf 設定

```
txindex=1
addressindex=1
timestampindex=1
spentindex=1
rpcuser=nezirin
rpcpassword=eclipse
rpcport=31916
rpcallowip=127.0.0.1
server=1
```

`spentindex=1` が重要。これがないと `getDetailedTransaction` の
vin に `address` / `value` が含まれず残高計算が壊れる。

---

## インストール手順（WSL2）

```bash
# リポジトリクローン（または既存ディレクトリで作業）
cd ~/vipstarcoin-api

# 新しい package.json に差し替え後
npm install

# 起動テスト
RPC_USER=nezirin RPC_PASS=eclipse node server.js
```

---

## 確認すべき RPC メソッド名

vipstarcoind-rpc の callspec にない RPC があると
「Method not found」エラーになる。
必要に応じて `callspec.js` に追記する。

疑わしいメソッド：
- `getStakingInfo`  → `getstakinginfo`
- `getDgpInfo`      → `getdgpinfo`
- `getSubsidy`      → `getsubsidy`
- `getBlockHashes`  → `getblockhashes`（timestampindex用）
- `callContract`    → `callcontract`
- `getAccountInfo`  → `getaccountinfo`
- `getTransactionReceipt` → `gettransactionreceipt`
- `getAddressBalance`     → `getaddressbalance`
- `getAddressUtxos`       → `getaddressutxos`
- `getAddressTxids`       → `getaddresstxids`
- `getAddressMempool`     → `getaddressmempool`
