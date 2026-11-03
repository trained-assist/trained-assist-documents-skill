'use strict';

function denyNetwork() {
  if (process.send) process.send({ blockedNetworkAttempt: true });
  throw new Error('OFFLINE_PROBE_NETWORK_DENIED');
}

globalThis.fetch = denyNetwork;
for (const protocol of ['node:http', 'node:https']) {
  const transport = require(protocol);
  transport.request = denyNetwork;
  transport.get = denyNetwork;
}
const net = require('node:net');
net.connect = denyNetwork;
net.createConnection = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
require('node:tls').connect = denyNetwork;
require('node:dgram').createSocket = denyNetwork;
require('node:module').syncBuiltinESMExports();
if (process.send) process.send({ networkGuardActive: true });
