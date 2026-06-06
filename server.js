'use strict';

/**
 * server.js  –  vipstarcoin-api スタンドアロン起動
 *
 * Usage:
 *   RPC_HOST=127.0.0.1 RPC_PORT=31916 RPC_USER=nezirin RPC_PASS=eclipse \
 *   MONGO_DB=vipstarcoin PORT=3001 node server.js
 */

var http = require('http');
var express = require('express');
var socketio = require('socket.io');

var VipstarcoindNode = require('./lib/node');
var InsightAPI = require('./lib/index');

// ─── 設定 ──────────────────────────────────────────────────────
var config = {
  port: parseInt(process.env.PORT) || 3001,
  routePrefix: process.env.ROUTE_PREFIX || 'vipstarcoin-api',
  enableCache: process.env.ENABLE_CACHE === 'true',

  rpc: {
    protocol: process.env.RPC_PROTOCOL || 'http',
    host: process.env.RPC_HOST || '127.0.0.1',
    port: parseInt(process.env.RPC_PORT) || 31916,
    user: process.env.RPC_USER || 'nezirin',
    pass: process.env.RPC_PASS || 'eclipse'
  },

  db: {
    host: process.env.MONGO_HOST || '127.0.0.1',
    port: parseInt(process.env.MONGO_PORT) || 27017,
    database: process.env.MONGO_DB || 'vipstarcoin',
    user: process.env.MONGO_USER || '',
    password: process.env.MONGO_PASS || ''
  },

  erc20: {
    updateFromBlockHeight: parseInt(process.env.ERC20_FROM_HEIGHT) || 0
  }
};

// ─── ロガー ────────────────────────────────────────────────────
var log = {
  info: function () { console.log('[INFO]', ...arguments); },
  warn: function () { console.warn('[WARN]', ...arguments); },
  error: function () { console.error('[ERROR]', ...arguments); }
};

// ─── VipstarcoindNode（RPC シム） ──────────────────────────────
var node = new VipstarcoindNode({ rpc: config.rpc, log: log });

// ─── InsightAPI 初期化 ─────────────────────────────────────────
var api = new InsightAPI({
  node: node,
  name: config.routePrefix,   // BaseService が this.name として使う
  routePrefix: config.routePrefix,
  enableCache: config.enableCache,
  db: config.db,
  erc20: config.erc20
});

// ─── Express + Socket.IO ───────────────────────────────────────
var app = express();
var server = http.createServer(app);
var io = socketio(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ─── Socket.IO 接続処理 ────────────────────────────────────────
// InsightAPI が管理する subscriptions に socket を登録する
io.on('connection', function (socket) {
  socket.on('subscribe', function (room) {
    log.info('[socket.io] subscribe:', socket.id, room);
    api.subscribe(socket, room);
  });

  socket.on('unsubscribe', function (room) {
    log.info('[socket.io] unsubscribe:', socket.id, room);
    api.unsubscribe(socket, room);
  });

  socket.on('disconnect', function () {
    ['inv', 'vipstarcoin'].forEach(function (room) {
      api.unsubscribe(socket, room);
    });
  });
});

// ─── 起動シーケンス ────────────────────────────────────────────
// HTTP サーバーを先に立ち上げ、バックグラウンドサービスは後から追いかける。
// StatisticService の processPrevBlocks が完了するまで待つと
// server.listen() に到達しないため、この順序が正しい。

log.info('Starting vipstarcoin-api...');
log.info('RPC endpoint:', config.rpc.host + ':' + config.rpc.port);

// 1. ルート設定
// ルート設定（routePrefix 配下にマウント）
var router = express.Router();
api.setupRoutes(router);
app.use('/' + config.routePrefix, router);

// 2. HTTP サーバー起動（サービス完了を待たない）
server.listen(config.port, function () {
  log.info('─────────────────────────────────────────');
  log.info('vipstarcoin-api ready');
  log.info('  http://localhost:' + config.port + '/' + config.routePrefix);
  log.info('─────────────────────────────────────────');
});

// 3. バックグラウンドサービス起動（処理が終わるまで時間がかかる）
api.start(function (err) {
  if (err) {
    log.error('[api.start] service error:', err);
    // エラーがあってもサーバー自体は継続する
  } else {
    log.info('[api.start] all background services ready');
  }
});

// ─── シャットダウン ────────────────────────────────────────────
function shutdown(signal) {
  log.info('Received', signal, '– shutting down...');
  node.stop();
  server.close(function () {
    log.info('Server closed. Bye.');
    process.exit(0);
  });
  setTimeout(function () { process.exit(1); }, 10000).unref();
}

process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });

process.on('uncaughtException', function (err) {
  log.error('Uncaught exception:', err);
});
