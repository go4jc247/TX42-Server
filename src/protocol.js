'use strict';

// ============================================================
// TX42-Server — protocol.js
// Message router: parse, validate, dispatch, broadcast
// ============================================================

const { Session, PHASE } = require('./session');
const {
  joinRoom, leaveRoom, reconnect, getRoom,
  roomStatus, broadcastToRoom, sendToSeat,
} = require('./rooms');
const { handleChat, handleChatClear } = require('./chat');
const { recordActivity } = require('./connection');
const { tileEquals } = require('./tiles');
const { aiBid, aiChooseTrump, aiChoosePlay } = require('./ai');

/**
 * Handle an incoming WebSocket message.
 * @param {Map} rooms - all rooms
 * @param {WebSocket} ws - the sender
 * @param {string} rawData - raw message string
 */
function handleMessage(rooms, ws, rawData) {
  recordActivity(ws);

  let msg;
  try {
    msg = JSON.parse(rawData);
  } catch (_) {
    _send(ws, { type: 'error', reason: 'Invalid JSON' });
    return;
  }

  // --- Top-level message types ---
  const type = msg.type;

  switch (type) {
    case 'join':
      return _handleJoin(rooms, ws, msg);
    case 'observe':
      return _handleObserve(rooms, ws, msg);
    case 'room_status':
      return _send(ws, { type: 'room_status', rooms: roomStatus(rooms) });
    case 'ping':
      return _send(ws, { type: 'pong', t: Date.now() });
    case 'chat':
      return _routeChat(rooms, ws, msg);
    case 'chat_clear':
      return _routeChatClear(rooms, ws, msg);
    case 'move':
      return _handleMove(rooms, ws, msg.move || msg);
    default:
      // Try treating as a move action directly
      if (msg.action) {
        return _handleMove(rooms, ws, msg);
      }
      _send(ws, { type: 'error', reason: 'Unknown message type: ' + type });
  }
}

// ----------------------------------------------------------
// Join / Observe
// ----------------------------------------------------------

function _handleJoin(rooms, ws, msg) {
  const roomName = msg.room || msg.roomName;
  const playerName = msg.name || msg.playerName || 'Anonymous';
  const playerId = msg.playerId || ws._connectionId + '';

  const result = joinRoom(rooms, ws, roomName, playerName, playerId);
  if (!result.success) {
    _send(ws, { type: 'join_rejected', reason: result.reason });
    return;
  }

  const room = result.room;

  // Send seat assignment to the joining player
  _send(ws, {
    type: 'move',
    move: {
      action: 'seat_assign',
      seat: result.seat,
      room: roomName,
      playerId,
      reconnected: result.reconnected || false,
    },
  });

  // Broadcast updated player list to the room
  _broadcastPlayerList(room);

  // If reconnected and there's an active session, send state sync
  if (result.reconnected && room.session) {
    _send(ws, {
      type: 'move',
      move: {
        action: 'state_sync',
        snapshot: room.session.playerSnapshot(result.seat),
      },
    });
  }
}

function _handleObserve(rooms, ws, msg) {
  const roomName = msg.room || msg.roomName;
  const room = getRoom(rooms, roomName);
  if (!room) {
    _send(ws, { type: 'observe_rejected', reason: 'Room not found' });
    return;
  }
  room.observers.add(ws);
  ws._roomName = roomName;
  _send(ws, { type: 'observe_accepted', room: roomName });
}

// ----------------------------------------------------------
// Move router
// ----------------------------------------------------------

function _handleMove(rooms, ws, move) {
  if (!move || !move.action) return;

  const roomName = ws._roomName;
  if (!roomName) {
    _send(ws, { type: 'error', reason: 'Not in a room' });
    return;
  }

  const room = getRoom(rooms, roomName);
  if (!room) return;

  // --- Relay mode: forward to all other room members ---
  if (!room.managed) {
    broadcastToRoom(room, { type: 'move', move }, ws);
    return;
  }

  // --- Managed mode: validate and dispatch ---
  const seat = ws._seat;
  const action = move.action;

  switch (action) {
    case 'hello':
      return _handleHello(room, ws, move);
    case 'seat_ack':
      // Client acknowledges seat assignment — no action needed
      return;
    case 'start_game':
      return _handleStartGame(room, ws, move);
    case 'bid_intent':
      return _handleBidIntent(room, ws, seat, move);
    case 'pass_intent':
      return _handlePassIntent(room, ws, seat, move);
    case 'trump_intent':
      return _handleTrumpIntent(room, ws, seat, move);
    case 'play_intent':
      return _handlePlayIntent(room, ws, seat, move);
    case 'refresh_request':
      return _handleRefreshRequest(room, ws, seat);
    case 'heartbeat':
      // Activity heartbeat — just record and optionally broadcast
      broadcastToRoom(room, { type: 'move', move: { action: 'heartbeat', seat } }, ws);
      return;
    default:
      // Unknown action in managed mode — relay anyway for extensibility
      broadcastToRoom(room, { type: 'move', move }, ws);
  }
}

// ----------------------------------------------------------
// Game actions (managed mode)
// ----------------------------------------------------------

function _handleHello(room, ws, move) {
  // Player announces presence — broadcast player list
  _broadcastPlayerList(room);
}

/** Check if a seat is AI (no connected human player). */
function _isAI(room, seat) {
  const player = room.players.get(seat);
  return !player || !player.connected;
}

/** Process AI turns — keeps running while the current player is AI. */
function _processAITurns(room) {
  const session = room.session;
  if (!session) return;

  // Small delay to make AI feel natural
  setTimeout(() => _doAITurn(room), 500);
}

function _doAITurn(room) {
  try {
  const session = room.session;
  if (!session) return;
  const phase = session.phase;
  console.log(`[AI] Processing turn: phase=${phase}, currentBidder=${session.currentBidder}, currentPlayer=${session.game ? session.game.currentPlayer : '?'}`);

  if (phase === 'NEED_BID') {
    const bidder = session.currentBidder;
    if (!_isAI(room, bidder)) return; // Human's turn

    const hand = session.game.hands[bidder];
    const decision = aiBid(hand, session.highBid || 0, 'T42');

    if (decision.action === 'bid') {
      const result = session.processBid(bidder, decision.bid, 1);
      if (result.valid) {
        broadcastToRoom(room, { type: 'move', move: {
          action: 'bid_confirmed', seat: bidder, bid: decision.bid,
          nextBidder: session.currentBidder, biddingDone: result.biddingDone,
          bidWinner: result.bidWinner, highBid: session.highBid,
        }});
        if (result.biddingDone && result.bidWinner >= 0) {
          // If bid winner is AI, auto-pick trump
          setTimeout(() => _doAITurn(room), 500);
        } else if (!result.biddingDone) {
          setTimeout(() => _doAITurn(room), 500);
        }
        return;
      }
    }
    // Pass
    const result = session.processPass(bidder);
    if (result.valid) {
      broadcastToRoom(room, { type: 'move', move: {
        action: 'pass_confirmed', seat: bidder,
        nextBidder: session.currentBidder, biddingDone: result.biddingDone,
        allPassed: result.allPassed, bidWinner: result.bidWinner, highBid: session.highBid,
      }});
      if (result.allPassed) {
        // Redeal
        _startGame(room, session.marksToWin);
      } else if (result.biddingDone && result.bidWinner >= 0) {
        setTimeout(() => _doAITurn(room), 500);
      } else {
        setTimeout(() => _doAITurn(room), 500);
      }
    }
    return;
  }

  if (phase === 'NEED_TRUMP') {
    const winner = session.bidWinnerSeat;
    if (!_isAI(room, winner)) return; // Human picks trump

    const hand = session.game.hands[winner];
    const decision = aiChooseTrump(hand);
    const trump = decision.trump;
    const isNello = false;
    const mode = (trump === 'DOUBLES') ? 'DOUBLES' : 'PIP';

    const result = session.processTrump(winner, trump === 'DOUBLES' ? -1 : trump, isNello);
    if (result.valid) {
      broadcastToRoom(room, { type: 'move', move: {
        action: 'trump_confirmed', seat: winner,
        trump: trump, trumpMode: mode,
        firstPlayer: session.game.currentPlayer,
      }});
      setTimeout(() => _doAITurn(room), 500);
    }
    return;
  }

  if (phase === 'PLAYING') {
    const currentPlayer = session.game.currentPlayer;
    if (!_isAI(room, currentPlayer)) return; // Human's turn

    const playIdx = aiChoosePlay(session.game, currentPlayer);
    if (playIdx === null) return;

    const tile = session.game.hands[currentPlayer][playIdx];
    const result = session.processPlay(currentPlayer, tile);
    if (result.valid) {
      const move = {
        action: 'play_confirmed',
        seat: currentPlayer,
        tile: [tile[0], tile[1]],
        isLead: result.isLead,
        trickNumber: result.trickNumber,
        nextPlayer: session.game.currentPlayer,
        currentPlayer: session.game.currentPlayer,
        trickComplete: result.trickComplete,
        trickWinner: result.trickWinner,
        handComplete: result.handComplete,
        teamPoints: session.game.teamPoints,
      };
      if (result.handComplete && result.handResult) {
        move.handResult = result.handResult;
        move.teamMarks = session.teamMarks;
      }
      broadcastToRoom(room, { type: 'move', move });

      if (result.handComplete) {
        if (session.phase === 'GAME_OVER') {
          broadcastToRoom(room, { type: 'move', move: { action: 'game_over', teamMarks: session.teamMarks } });
        } else {
          // Deal next hand after a pause
          setTimeout(() => {
            session.dealNewHand();
            for (const [s, p] of room.players) {
              if (p.connected && p.ws) {
                sendToSeat(room, s, { type: 'move', move: {
                  action: 'deal', seat: s,
                  hand: session.game.hands[s].map(t => [t[0], t[1]]),
                  dealer: session.dealer, handNumber: session.handNumber,
                  firstBidder: session.currentBidder,
                  teamMarks: session.teamMarks,
                }});
              }
            }
            setTimeout(() => _doAITurn(room), 500);
          }, 2000);
        }
      } else {
        setTimeout(() => _doAITurn(room), 500);
      }
    }
    return;
  }
  } catch(err) {
    console.error('[AI] Error in _doAITurn:', err.message, err.stack);
  }
}

function _handleStartGame(room, ws, move) {
  _startGame(room, move && move.marksToWin);
}

function _startGame(room, marksToWin) {
  // Create a new session if one doesn't exist
  if (!room.session) {
    room.session = new Session(marksToWin || 7);
  }

  room.session.startGame();

  // Broadcast start_game to all players
  broadcastToRoom(room, {
    type: 'move',
    move: {
      action: 'start_game',
      gameMode: 'T42',
      marksToWin: room.session.marksToWin || 7,
    },
  });

  // Send dealt hands to each player individually
  for (const [seat, player] of room.players) {
    if (player.connected && player.ws) {
      sendToSeat(room, seat, {
        type: 'move',
        move: {
          action: 'deal',
          seat,
          hand: room.session.game.hands[seat].map(t => [t[0], t[1]]),
          dealer: room.session.dealer,
          handNumber: room.session.handNumber,
          firstBidder: room.session.currentBidder,
        },
      });
    }
  }

  console.log(`[PROTO] Game started in ${room.name}: dealer=seat ${room.session.dealer}, first bidder=seat ${room.session.currentBidder}`);

  // If first bidder is AI, start AI turns
  _processAITurns(room);
}

function _handleBidIntent(room, ws, seat, move) {
  const session = room.session;
  if (!session) return _sendRejection(ws, 'bid', 'No active game');

  const result = session.processBid(move.seat, move.bid, move.marks || 1);
  if (!result.valid) {
    return _sendRejection(ws, 'bid', result.reason);
  }

  // Build confirmed message
  const confirmed = {
    action: 'bid_confirmed',
    seat: move.seat,
    bid: move.bid,
    marks: move.marks || 1,
    displayBid: (move.marks > 1) ? (move.marks + 'x') : move.bid,
    biddingDone: result.biddingDone || false,
    nextBidder: result.nextBidder || null,
    bidWinner: result.bidWinner !== undefined ? result.bidWinner : null,
    winningBid: result.winningBid || null,
    winningMarks: result.winningMarks || null,
    redeal: result.redeal || false,
  };

  broadcastToRoom(room, { type: 'move', move: confirmed });

  // If redeal, auto-deal new hand
  if (result.redeal) {
    setTimeout(() => {
      if (room.session) {
        room.session.dealNewHand();
        _sendDealToAll(room);
        _processAITurns(room);
      }
    }, 1500);
  } else {
    _processAITurns(room);
  }
}

function _handlePassIntent(room, ws, seat, move) {
  const session = room.session;
  if (!session) return _sendRejection(ws, 'pass', 'No active game');

  const result = session.processPass(move.seat);
  if (!result.valid) {
    return _sendRejection(ws, 'pass', result.reason);
  }

  const confirmed = {
    action: 'pass_confirmed',
    seat: move.seat,
    biddingDone: result.biddingDone || false,
    nextBidder: result.nextBidder || null,
    bidWinner: result.bidWinner !== undefined ? result.bidWinner : null,
    winningBid: result.winningBid || null,
    winningMarks: result.winningMarks || null,
    redeal: result.redeal || false,
  };

  broadcastToRoom(room, { type: 'move', move: confirmed });

  if (result.redeal) {
    setTimeout(() => {
      if (room.session) {
        room.session.dealNewHand();
        _sendDealToAll(room);
        _processAITurns(room);
      }
    }, 1500);
  } else {
    _processAITurns(room);
  }
}

function _handleTrumpIntent(room, ws, seat, move) {
  const session = room.session;
  if (!session) return _sendRejection(ws, 'trump', 'No active game');

  let trumpValue = move.trump;
  if (trumpValue === 'NT') trumpValue = null;

  const nello = move.nello || false;
  const result = session.processTrump(move.seat, nello ? 'NELLO' : trumpValue, nello);

  if (!result.valid) {
    return _sendRejection(ws, 'trump', result.reason);
  }

  const confirmed = {
    action: 'trump_confirmed',
    trump: move.trump,
    seat: move.seat,
    marks: session.bidMarks,
    nello: nello,
    contract: session.contract,
    currentPlayer: session.game.currentPlayer,
    activePlayers: session.game.activePlayers.slice(),
    trumpSuit: session.game.trumpSuit,
    trumpMode: session.game.trumpMode,
  };

  broadcastToRoom(room, { type: 'move', move: confirmed });
  _processAITurns(room);
}

function _handlePlayIntent(room, ws, seat, move) {
  const session = room.session;
  if (!session) return _sendRejection(ws, 'play', 'No active game');

  // Validate turn
  if (move.seat !== session.game.currentPlayer) {
    _send(ws, {
      type: 'move',
      move: {
        action: 'play_rejected',
        seat: move.seat,
        reason: 'Not your turn (expected seat ' + session.game.currentPlayer + ')',
      },
    });
    return;
  }

  // Find tile in hand
  const hand = session.game.hands[move.seat] || [];
  let handIndex = -1;
  for (let i = 0; i < hand.length; i++) {
    if (tileEquals(hand[i], move.tile)) {
      handIndex = i;
      break;
    }
  }
  if (handIndex < 0) {
    _send(ws, {
      type: 'move',
      move: { action: 'play_rejected', seat: move.seat, reason: 'Tile not in hand' },
    });
    return;
  }

  // Check legality
  const legal = session.game.legalIndicesForPlayer(move.seat);
  if (!legal.includes(handIndex)) {
    _send(ws, {
      type: 'move',
      move: { action: 'play_rejected', seat: move.seat, reason: 'Illegal move' },
    });
    return;
  }

  // Record whether this is a lead play
  const isLead = session.game.currentTrick.length === 0;

  // Execute play
  const result = session.processPlay(move.seat, handIndex);
  if (!result.valid) {
    _send(ws, {
      type: 'move',
      move: { action: 'play_rejected', seat: move.seat, reason: result.reason },
    });
    return;
  }

  // Build confirmed message
  const confirmed = {
    action: 'play_confirmed',
    seat: move.seat,
    tile: move.tile,
    isLead: isLead,
    trickNumber: session.game.trickNumber,
    nextPlayer: session.game.currentPlayer,
    currentPlayer: session.game.currentPlayer,
    trickComplete: result.trickComplete,
    trickWinner: result.trickWinner,
    handComplete: result.handComplete,
    handResult: result.handResult,
    teamPoints: session.game.teamPoints.slice(),
  };

  broadcastToRoom(room, { type: 'move', move: confirmed });

  if (result.handComplete) {
    if (session.phase === 'GAME_OVER') {
      broadcastToRoom(room, { type: 'move', move: { action: 'game_over', teamMarks: session.teamMarks } });
    } else {
      // Deal next hand after a pause
      setTimeout(() => {
        if (room.session) {
          room.session.dealNewHand();
          _sendDealToAll(room);
          _processAITurns(room);
        }
      }, 2000);
    }
  } else {
    _processAITurns(room);
  }
}

function _handleRefreshRequest(room, ws, seat) {
  const session = room.session;
  if (!session) return;

  _send(ws, {
    type: 'move',
    move: {
      action: 'state_sync',
      snapshot: session.playerSnapshot(seat),
    },
  });
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

/** Send dealt hands to each player individually. */
function _sendDealToAll(room) {
  const session = room.session;
  if (!session) return;

  for (const [seat, player] of room.players) {
    if (player.connected && player.ws) {
      sendToSeat(room, seat, {
        type: 'move',
        move: {
          action: 'deal',
          seat,
          hand: session.game.hands[seat].map(t => [t[0], t[1]]),
          dealer: session.dealer,
          handNumber: session.handNumber,
          firstBidder: session.currentBidder,
        },
      });
    }
  }

  // Observers get full state
  for (const obsWs of room.observers) {
    try {
      obsWs.send(JSON.stringify({
        type: 'move',
        move: {
          action: 'deal',
          snapshot: session.fullSnapshot(),
        },
      }));
    } catch (_) { /* ignore */ }
  }
}

/** Broadcast player list to all in a room. */
function _broadcastPlayerList(room) {
  const playerList = [];
  for (const [seat, player] of room.players) {
    playerList.push({
      seat,
      name: player.name,
      connected: player.connected,
      playerId: player.playerId,
    });
  }

  broadcastToRoom(room, {
    type: 'move',
    move: {
      action: 'player_list',
      players: playerList,
      room: room.name,
    },
  });
}

/** Route chat message to the appropriate room. */
function _routeChat(rooms, ws, msg) {
  const roomName = ws._roomName;
  if (!roomName) return;
  const room = getRoom(rooms, roomName);
  if (!room) return;
  handleChat(room, ws, msg);
}

function _routeChatClear(rooms, ws, msg) {
  const roomName = ws._roomName;
  if (!roomName) return;
  const room = getRoom(rooms, roomName);
  if (!room) return;
  handleChatClear(room, ws);
}

/** Send a message to a single WebSocket. */
function _send(ws, msg) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  } catch (_) { /* ignore */ }
}

/** Send a rejection message. */
function _sendRejection(ws, action, reason) {
  _send(ws, {
    type: 'move',
    move: { action: action + '_rejected', reason },
  });
}

module.exports = { handleMessage };
