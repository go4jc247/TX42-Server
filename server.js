'use strict';

// ============================================================
// TX42-Server — server.js
// Entry point: HTTP health endpoint + WebSocket game server
// ============================================================

const http = require('http');
const { WebSocketServer } = require('ws');
const { createRooms, leaveRoom, roomStatus } = require('./src/rooms');
const { initConnection, startHeartbeat, handlePong } = require('./src/connection');
const { handleMessage } = require('./src/protocol');

const PORT = process.env.PORT || 10000;

// ----------------------------------------------------------
// HTTP Server (health check)
// ----------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/health/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      rooms: roomStatus(rooms).map(r => ({
        name: r.name,
        players: r.playerCount,
        phase: r.phase,
      })),
    }));
    return;
  }

  // Default response
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('TX42-Server running');
});

// ----------------------------------------------------------
// WebSocket Server
// ----------------------------------------------------------

const rooms = createRooms();

const wss = new WebSocketServer({ server: httpServer });

// Start heartbeat system
const heartbeatInterval = startHeartbeat(wss);

// Allowed room names for the info message
const allowedRooms = Array.from(rooms.keys());

wss.on('connection', (ws, req) => {
  const { connectionId } = initConnection(ws);
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[SERVER] New connection #${connectionId} from ${clientIp}`);

  // Send welcome info
  ws.send(JSON.stringify({
    type: 'info',
    server: 'TX42-Server',
    version: '1.0.0',
    connectionId,
    rooms: allowedRooms,
    message: 'Welcome! Send { type: "join", room: "<roomName>", name: "<yourName>" } to join a room.',
  }));

  // Handle pong (heartbeat response)
  ws.on('pong', () => {
    handlePong(ws);
  });

  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      const rawData = data.toString();
      handleMessage(rooms, ws, rawData);
    } catch (err) {
      console.error(`[SERVER] Error handling message from #${connectionId}:`, err.message);
    }
  });

  // Handle disconnect
  ws.on('close', (code, reason) => {
    console.log(`[SERVER] Connection #${connectionId} closed (code=${code})`);
    leaveRoom(rooms, ws);
  });

  ws.on('error', (err) => {
    console.error(`[SERVER] Connection #${connectionId} error:`, err.message);
  });
});

// ----------------------------------------------------------
// Start listening
// ----------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`[TX42-Server] Listening on port ${PORT}`);
  console.log(`[TX42-Server] Health check: http://localhost:${PORT}/health`);
  console.log(`[TX42-Server] Rooms: ${allowedRooms.join(', ')}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[TX42-Server] SIGTERM received — shutting down');
  clearInterval(heartbeatInterval);
  wss.close(() => {
    httpServer.close(() => {
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('[TX42-Server] SIGINT received — shutting down');
  clearInterval(heartbeatInterval);
  wss.close(() => {
    httpServer.close(() => {
      process.exit(0);
    });
  });
});
