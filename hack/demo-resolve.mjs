// Preloaded into the demo server with `node --import`. The documentation's hosts
// have real-looking names (`web-01.prod.internal`) that resolve nowhere, so this
// maps them onto the loopback ports the sandbox sshds listen on. Nothing else in
// the process changes — the SSH client still does a full connect, key exchange,
// host-key check and authentication.
import net from 'node:net';

const MAP = JSON.parse(process.env.MUXUS_DEMO_HOSTMAP || '{}');
const original = /** @type {Function} */ (net.Socket.prototype).connect;

net.Socket.prototype.connect = function connect(...args) {
  const [first] = args;
  if (first && typeof first === 'object' && MAP[first.host]) {
    return original.call(this, { ...first, host: '127.0.0.1', port: MAP[first.host] }, ...args.slice(1));
  }
  // net.connect(port, host, cb)
  if (typeof first === 'number' && typeof args[1] === 'string' && MAP[args[1]]) {
    return original.call(this, MAP[args[1]], '127.0.0.1', ...args.slice(2));
  }
  return original.apply(this, args);
};
