'use strict';

// ============================================================
// TX42-Server — connection.js
// WebSocket connection handler with heartbeat and tracking
// ============================================================

let _nextConnectionId = 1;

/** Heartbeat interval: server pings every 20s */
const HEARTBEAT_INTERVAL_MS = 20000;
/** Connection timeout: disconnect if no pong after 45s */
const HEARTBEAT_TIMEOUT_MS = 45000;

/**
 * Initialize a WebSocket connection with heartbeat and tracking.
 * @param {WebSocket} ws - the WebSocket connection
 * @returns {object} connection info { connectionId, ws }
 */
function initConnection(ws) {
  const connectionId = _nextConnectionId++;

  ws._connectionId = connectionId;
  ws._lastActivity = Date.now();
  ws._alive = true;

  return { connectionId, ws };
}

/**
 * Start the heartbeat system for the WebSocket server.
 * Pings all clients every HEARTBEAT_INTERVAL_MS.
 * Terminates connections that haven't responded within HEARTBEAT_TIMEOUT_MS.
 * @param {WebSocket.Server} wss - the WebSocket server
 * @returns {NodeJS.Timeout} the interval handle (for cleanup)
 */
function startHeartbeat(wss) {
  const interval = setInterval(() => {
    const now = Date.now();
    wss.clients.forEach((ws) => {
      // Check if connection has timed out
      if (now - ws._lastActivity > HEARTBEAT_TIMEOUT_MS) {
        console.log(`[CONN] Heartbeat timeout for connection ${ws._connectionId} — terminating`);
        ws.terminate();
        return;
      }

      // Send ping
      if (ws.readyState === 1 /* OPEN */) {
        try {
          ws.ping();
        } catch (_) {
          // Ignore ping errors
        }
      }
    });
  }, HEARTBEAT_INTERVAL_MS);

  return interval;
}

/**
 * Handle pong response — update last activity timestamp.
 * @param {WebSocket} ws
 */
function handlePong(ws) {
  ws._lastActivity = Date.now();
  ws._alive = true;
}

/**
 * Record any activity on the connection.
 * @param {WebSocket} ws
 */
function recordActivity(ws) {
  ws._lastActivity = Date.now();
}

/**
 * Get connection info for a WebSocket.
 * @param {WebSocket} ws
 */
function connectionInfo(ws) {
  return {
    connectionId: ws._connectionId,
    roomName: ws._roomName || null,
    seat: ws._seat !== undefined ? ws._seat : null,
    playerId: ws._playerId || null,
    lastActivity: ws._lastActivity,
    alive: ws._alive,
  };
}

module.exports = {
  initConnection,
  startHeartbeat,
  handlePong,
  recordActivity,
  connectionInfo,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
};
