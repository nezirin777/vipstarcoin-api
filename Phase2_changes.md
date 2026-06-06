# Phase 2 – 変更内容まとめ

vipstarcoincore-node 依存を切り離し、スタンドアロン Express アプリとして再構築した。

---

## 新規作成ファイル

### lib/node.js
vipstarcoincore-node の代替シム。vipstarcoind-rpc を直接ラップし、
既存コードが期待する `node.*` / `node.services.vipstarcoind.*`
インターフェースをすべて提供する。

主な実装内容：
- ポーリングによる tip 監視（5秒間隔）・'tip'/'block' イベント発行
- `getInfo` を `getBlockchainInfo` + `getNetworkInfo` + `getWalletInfo` で合成
  （Qtum 0.20.3 ベースで `getinfo` RPC が廃止されているため）
- `getDetailedTransaction` に prevout フォールバック実装
  （`spentindex` が vin に値を付けない場合、前 tx を取得して補完）
- `getBlock` で blockhash → `getBlockHeader` により height を解決
- `getAddressBalance` を MongoDB 経由に変更（後述）
- `setAddressBalanceRepository(repo)` でリポジトリを注入する口を提供

### server.js
スタンドアロン起動エントリーポイント。

起動順序を「HTTP サーバー先行、サービスはバックグラウンド」に設計。
（StatisticService の processPrevBlocks が完了するまで server.listen に
到達しない問題を回避するため）

環境変数で設定を上書き可能：
```
RPC_HOST / RPC_PORT / RPC_USER / RPC_PASS
MONGO_HOST / MONGO_PORT / MONGO_DB
PORT / ROUTE_PREFIX / ERC20_FROM_HEIGHT
```

---

## 既存ファイルの変更

### package.json
- `engines.node`: `>=0.12.0` → `>=18.0.0`
- `bitcore-lib` を削除、`vipstarcoin-lib` (nezirin777) に置き換え
- `vipstarcoind-rpc` (nezirin777) を追加
- `express` / `socket.io` を明示的に追加
- `lodash` `^2.4.1` → `^4.17.21`
- `mongoose` `^4.11.8` → `^5.13.22`
- `async` `^2.6.1` → `^3.2.5`
- `bignumber.js` `^4.0.2` → `^9.1.2`
- `web3` を `^0.20.7` で維持（SolidityCoder の内部パスを利用しているため）
- devDependencies を全般更新（mocha 10 / chai 4 / sinon 17）
- `vipstarcoincore-node` を peerDependencies から削除

### components/Db.js
mongoose v5 対応：
```diff
- return mongoose.connect(url, { useMongoClient: true }, function (err) {
+ return mongoose.connect(url, { useNewUrlParser: true, useUnifiedTopology: true }, function (err) {
```

### lib/index.js
- `InsightAPI.dependencies = ['vipstarcoind', 'web']` → `[]`
- リポジトリ作成直後に node へ注入を追加：
  ```javascript
  this.node.setAddressBalanceRepository(this.addressBalanceRepository);
  ```
- Morgan ログの Buffer → 文字列変換を修正：
  ```diff
  - self.node.log.info(chunk.slice(0, chunk.length - 1))
  + self.node.log.info(chunk.slice(0, chunk.length - 1).toString())
  ```

### repositories/AddressBalanceRepository.js
`getBalanceByAddress(address, callback)` を追加：
```javascript
AddressBalanceRepository.prototype.getBalanceByAddress = function(address, next) {
    return AddressBalance.findOne({address: address}, function(err, row) {
        return next(err, row ? row.balance : 0);
    });
};
```

### services/AddressBalanceService.js
`processBlock` を全面書き換え。

変更前：各アドレスの残高を `getAddressBalance` RPC で取得して上書き
変更後：tx の vout/vin からアドレスごとの残高変化量（delta）を計算して MongoDB に増分更新

bignumber.js v9 対応：
```diff
- while (balance.greaterThanOrEqualTo(nextBorder)) {
+ while (balance.isGreaterThanOrEqualTo(nextBorder)) {
```

### services/StatisticService.js
bignumber.js v9 対応：
```diff
- dayBN.supply.sum = SupplyHelper.getTotalSupplyByHeight(block.height).mul(1e8);
+ dayBN.supply.sum = SupplyHelper.getTotalSupplyByHeight(block.height).times(1e8);
```

---

## 変更不要なファイル

lib/blocks.js / lib/transactions.js / lib/addresses.js / lib/status.js /
lib/erc20.js / lib/erc20-watcher.js / lib/statistics.js / lib/contracts.js /
lib/messages.js / lib/utils.js / lib/currency.js / lib/markets.js /
lib/ratelimiter.js / lib/common.js / lib/service.js /
repositories/*.js（AddressBalanceRepository 以外） /
models/*.js / helpers/*.js / components/errors/*.js

---

## Phase 2 で判明した重要事項

### VIPS デーモンに addressindex / timestampindex / spentindex がない

v1.0.2・v1.2.4 ともにデーモン側にこれらのインデックスは存在しない。
元の vipstarcoin-api は vipstarcoincore-node が leveldb で
独自に実装していたインデックスに依存していた。

debug.log の起動ログ：
```
Ignoring unknown configuration value addressindex
Ignoring unknown configuration value timestampindex
Ignoring unknown configuration value spentindex
```

対応：`processBlock` を独自実装し、MongoDB にアドレス残高を蓄積する方式に変更。

### vipstarcoin.conf の正しい設定

```ini
server=1
txindex=1          ← 有効（getrawtransaction に必要）
rpcuser=nezirin
rpcpassword=eclipse
rpcport=31916
```

以下は VIPS デーモンが認識しないため不要（削除推奨）：
```ini
# addressindex=1   ← 無効
# timestampindex=1 ← 無効
# spentindex=1     ← 無効
```

### Qtum 0.20.3 で廃止された RPC

| 廃止 | 代替 |
|---|---|
| `getinfo` | `getblockchaininfo` + `getnetworkinfo` + `getwalletinfo` |

### bignumber.js v4 → v9 の API 変更

| v4 | v9 |
|---|---|
| `.mul(n)` | `.times(n)` |
| `.greaterThanOrEqualTo(n)` | `.isGreaterThanOrEqualTo(n)` |

---

## 動作確認済みエンドポイント

| エンドポイント | 状態 |
|---|---|
| `/status?q=getInfo` | ✅ |
| `/status?q=getStakingInfo` | ✅ |
| `/sync` | ✅ |
| `/block-index/:height` | ✅ |
| `/tx/:txid` | ✅ blockheight・valueSat 修正済み |
| `/addr/:addr/balance` | ✅ MongoDB 経由（スキャン完了アドレスのみ正確） |
| アドレス取引履歴 | ⚠️ Phase 3 課題 |

---

## 起動方法

```bash
# MongoDB を起動
sudo service mongod start

# API サーバーを起動
cd ~/vipstarcoin-api
RPC_USER=nezirin RPC_PASS=eclipse node server.js
```

---

## 残課題（Phase 3 以降）

- アドレス取引履歴（tx 一覧）のスキャナー実装
- 370 万ブロック分のアドレス残高スキャン完了（数時間〜半日）
- Morgan ログ Buffer 問題（軽微）
- `type: 'vipstarcoincore node'` 表記を `'vipstarcoin-api'` に修正（lib/status.js）
