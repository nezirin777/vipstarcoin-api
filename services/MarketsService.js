var util = require('util');
var EventEmitter = require('events').EventEmitter;
var request = require('request');
var _ = require('lodash');
var Common = require('../lib/common');

function MarketsService(options) {

    this.common = new Common({log: options.node.log});

    this.info = {
        price_usd: 0,
        price_btc: 0,
        market_cap_usd: 0
    };

    this._updateInfo();

    var self = this;

    setInterval(function () {
        self._updateInfo();
    }, 90000);

}

util.inherits(MarketsService, EventEmitter);

MarketsService.prototype._updateInfo = function() {
    // CoinMarketCap アクセス無効化
    this.common.log.info('CoinMarketCap: アクセス無効化済み');
    return;
};

MarketsService.prototype.getInfo = function(next) {
    return next(null, this.info);
};

module.exports = MarketsService;
