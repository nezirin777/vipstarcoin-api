var BigNumber = require('bignumber.js');

module.exports = {
    /**
     *
     * TODO: not work for VIPSTARCOIN
     * @param {Number} height
     * @return {BigNumber}
     */
    getTotalSupplyByHeight: function (height) {
        return (new BigNumber(100000000)).plus((height - 5000) * 4);
    }

};
