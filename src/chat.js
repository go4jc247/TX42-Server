'use strict';

// ============================================================
// TX42-Server — chat.js
// Simple chat message relay
// ============================================================

const { broadcastToRoom } = require('./rooms');

/**
 * Handle an incoming chat message.
 * Broadcasts to all room members except the sender.
 * @param {object} room - the room object
 * @param {WebSocket} ws - sender's WebSocket
 * @param {object} msg - the chat message { type: 'chat', text, sender, ... }
 */
function handleChat(room, ws, msg) {
  if (!room || !msg) return;

  const outgoing = {
    type: 'chat',
    sender: msg.sender || msg.name || ('Seat ' + (ws._seat !== undefined ? ws._seat : '?')),
    seat: ws._seat !== undefined ? ws._seat : null,
    text: msg.text || '',
    timestamp: Date.now(),
  };

  broadcastToRoom(room, outgoing, ws);
}

/**
 * Handle a chat_clear message.
 * Broadcasts clear instruction to all room members.
 * @param {object} room - the room object
 * @param {WebSocket} ws - sender's WebSocket
 */
function handleChatClear(room, ws) {
  if (!room) return;

  const outgoing = {
    type: 'chat_clear',
    seat: ws._seat !== undefined ? ws._seat : null,
    timestamp: Date.now(),
  };

  broadcastToRoom(room, outgoing, ws);
}

module.exports = {
  handleChat,
  handleChatClear,
};
