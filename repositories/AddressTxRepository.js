const AddressTx = require('../models/AddressTx');
const async = require('async');

function AddressTxRepository() {}

/**
 * アドレスと txid のマッピングを保存（重複は無視）
 *
 * @param {Object} data
 * @param {String} data.address
 * @param {String} data.txid
 * @param {Number} data.height
 * @param {Number} data.blockTime
 * @param {Function} next
 */
AddressTxRepository.prototype.addTx = function (data, next) {
    return AddressTx.findOneAndUpdate(
        { address: data.address, txid: data.txid },
        data,
        { upsert: true, new: true },
        function (err) {
            // 重複キーエラーは無視して正常終了
            if (err && err.code === 11000) {
                return next();
            }
            return next(err);
        }
    );
};

/**
 * アドレスの txid 一覧を高さ降順（新しい順）で返す
 *
 * @param {String} address
 * @param {Function} next
 * @return {String[]} txid の配列
 */
AddressTxRepository.prototype.getTxidsByAddress = function (address, next) {
    return AddressTx.find(
        { address: address },
        { txid: 1, _id: 0 },
        { sort: { height: -1 } },
        function (err, rows) {
            if (err) return next(err);
            return next(null, rows.map(function (r) { return r.txid; }));
        }
    );
};

/**
 * 指定ブロック高以上のレコードを削除（チェーン巻き戻し用・将来対応）
 *
 * @param {Number} height
 * @param {Function} next
 */
AddressTxRepository.prototype.removeAboveHeight = function (height, next) {
    return AddressTx.remove({ height: { $gte: height } }, function (err) {
        return next(err);
    });
};

module.exports = AddressTxRepository;
