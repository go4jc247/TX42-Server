'use strict';

// ============================================================
// TX42-Server — rooms.js
// Room management: T42 game rooms + ClaudeChat relay room
// ============================================================

const { Session } = require('./session');

/** Grace period (ms) for reconnection after disconnect. */
const RECONNECT_GRACE_MS = 60000; // 60 seconds

/**
 * Create the default room set.
 * - 5 T42 rooms (max 4 players, managed mode)
 * - 1 ClaudeChat room (max 10, relay mode)
 */
function createRooms() {
  const rooms = new Map();

  // T42 managed game rooms
  for (let i = 1; i <= 5; i++) {
    const name = 'Tx42room' + String(i).padStart(3, '0');
    rooms.set(name, {
      name,
      mode: 'managed',
      managed: true,
      maxPlayers: 4,
      players: new Map(),       // seat -> { ws, name, playerId, connected, disconnectTimer }
      observers: new Set(),     // Set of ws
      session: null,            // Session instance (created on game start)
    });
  }

  // ClaudeChat relay room
  rooms.set('ClaudeChat', {
    name: 'ClaudeChat',
    mode: 'relay',
    managed: false,
    maxPlayers: 10,
    players: new Map(),
    observers: new Set(),
    session: null,
  });

  return rooms;
}

/**
 * Join a room. Assigns the next available seat.
 * @param {Map} rooms - all rooms
 * @param {WebSocket} ws - the connection
 * @param {string} roomName - room to join
 * @param {string} playerName - display name
 * @param {string} playerId - unique player identifier
 * @returns {{ success, seat?, room?, reason? }}
 */
function joinRoom(rooms, ws, roomName, playerName, playerId) {
  const room = rooms.get(roomName);
  if (!room) {
    return { success: false, reason: 'Room not found: ' + roomName };
  }

  // Check if player is already in the room (reconnect scenario)
  for (const [seat, player] of room.players) {
    if (player.playerId === playerId) {
      // Reconnect to existing seat
      if (player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
      }
      player.ws = ws;
      player.connected = true;
      player.name = playerName || player.name;
      ws._roomName = roomName;
      ws._seat = seat;
      ws._playerId = playerId;
      return { success: true, seat, room, reconnected: true };
    }
  }

  // Find next available seat
  const maxSeats = room.maxPlayers;
  let assignedSeat = -1;
  for (let s = 0; s < maxSeats; s++) {
    if (!room.players.has(s)) {
      assignedSeat = s;
      break;
    }
  }

  if (assignedSeat < 0) {
    // Check for disconnected players whose grace period may be over — boot them
    for (const [s, p] of room.players) {
      if (!p.connected) {
        if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
        room.players.delete(s);
        assignedSeat = s;
        break;
      }
    }
    if (assignedSeat < 0) {
      return { success: false, reason: 'Room is full' };
    }
  }

  // Assign seat
  room.players.set(assignedSeat, {
    ws,
    name: playerName || ('Player ' + (assignedSeat + 1)),
    playerId: playerId,
    connected: true,
    disconnectTimer: null,
  });

  ws._roomName = roomName;
  ws._seat = assignedSeat;
  ws._playerId = playerId;

  return { success: true, seat: assignedSeat, room };
}

/**
 * Leave a room — marks player as disconnected, starts grace timer.
 * @param {Map} rooms - all rooms
 * @param {WebSocket} ws - the disconnecting connection
 */
function leaveRoom(rooms, ws) {
  const roomName = ws._roomName;
  if (!roomName) return;

  const room = rooms.get(roomName);
  if (!room) return;

  // Remove from observers
  room.observers.delete(ws);

  // Find player by ws
  const seat = ws._seat;
  if (seat === undefined || seat === null) return;

  const player = room.players.get(seat);
  if (!player || player.ws !== ws) return;

  player.connected = false;
  player.ws = null;

  // Start grace period for reconnection
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectTimer = setTimeout(() => {
    // Grace period expired — remove player
    room.players.delete(seat);

    // If room is empty and has a session, clean it up
    if (room.players.size === 0 && room.session) {
      room.session = null;
    }
  }, RECONNECT_GRACE_MS);
}

/**
 * Reconnect a player to their seat within the grace period.
 * @param {Map} rooms - all rooms
 * @param {WebSocket} ws - new connection
 * @param {string} playerId - player's unique id
 * @param {string} roomName - optional room name hint
 * @returns {{ success, seat?, room?, reason? }}
 */
function reconnect(rooms, ws, playerId, roomName) {
  // Search specific room or all rooms
  const roomsToSearch = roomName
    ? [rooms.get(roomName)].filter(Boolean)
    : Array.from(rooms.values());

  for (const room of roomsToSearch) {
    for (const [seat, player] of room.players) {
      if (player.playerId === playerId && !player.connected) {
        // Found disconnected player — reconnect
        if (player.disconnectTimer) {
          clearTimeout(player.disconnectTimer);
          player.disconnectTimer = null;
        }
        player.ws = ws;
        player.connected = true;
        ws._roomName = room.name;
        ws._seat = seat;
        ws._playerId = playerId;
        return { success: true, seat, room };
      }
    }
  }

  return { success: false, reason: 'No disconnected seat found for player' };
}

/**
 * Get a room by name.
 */
function getRoom(rooms, name) {
  return rooms.get(name) || null;
}

/**
 * Get status of all rooms.
 */
function roomStatus(rooms) {
  const status = [];
  for (const [name, room] of rooms) {
    const connectedPlayers = [];
    for (const [seat, player] of room.players) {
      connectedPlayers.push({
        seat,
        name: player.name,
        connected: player.connected,
      });
    }
    status.push({
      room: name,
      mode: room.mode,
      max: room.maxPlayers,
      count: room.players.size,
      players: connectedPlayers,
      observers: room.observers.size,
      hasSession: !!room.session,
      phase: room.session ? room.session.phase : null,
    });
  }
  return status;
}

/**
 * Broadcast a message to all connected players and observers in a room.
 * @param {object} room - the room object
 * @param {object|string} msg - message to send (will be JSON.stringify'd if object)
 * @param {WebSocket} [excludeWs] - optional ws to exclude
 */
function broadcastToRoom(room, msg, excludeWs) {
  const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);

  for (const [, player] of room.players) {
    if (player.connected && player.ws && player.ws !== excludeWs) {
      try { player.ws.send(payload); } catch (_) { /* ignore send errors */ }
    }
  }

  for (const obsWs of room.observers) {
    if (obsWs !== excludeWs) {
      try { obsWs.send(payload); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Send a message to a specific seat in a room.
 */
function sendToSeat(room, seat, msg) {
  const player = room.players.get(seat);
  if (!player || !player.connected || !player.ws) return false;
  const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
  try {
    player.ws.send(payload);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  createRooms,
  joinRoom,
  leaveRoom,
  reconnect,
  getRoom,
  roomStatus,
  broadcastToRoom,
  sendToSeat,
  RECONNECT_GRACE_MS,
};
