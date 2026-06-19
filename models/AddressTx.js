const mongoose = require('mongoose');

const addressTxSchema = new mongoose.Schema({
    address: {
        type: String,
        required: true,
        index: true
    },
    txid: {
        type: String,
        required: true
    },
    height: {
        type: Number,
        required: true,
        index: true
    },
    blockTime: {
        type: Number,
        required: true
    }
}, {
    timestamps: {
        createdAt: 'created_at',
        updatedAt: 'updated_at'
    }
});

// address + txid の複合ユニークインデックス（重複登録防止）
addressTxSchema.index({ address: 1, txid: 1 }, { unique: true });

// アドレス別・高さ降順（取引履歴取得で使用）
addressTxSchema.index({ address: 1, height: -1 });

const AddressTx = mongoose.model('AddressTx', addressTxSchema);

module.exports = AddressTx;
