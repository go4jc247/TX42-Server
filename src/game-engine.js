'use strict';

// ============================================================
// TX42-Server — game-engine.js
// Ported from GameStateV6_4g in TX-Dom-Dev game.js
// Tracks one hand of Texas 42 play (4 players, double-6)
// ============================================================

const { countPoints, tileContainsPip } = require('./tiles');

class IllegalMoveError extends Error {
  constructor(msg) { super(msg); this.name = 'IllegalMoveError'; }
}

/**
 * Compare two rank arrays lexicographically.
 * Returns true if a > b.
 */
function lexGreater(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = i < a.length ? a[i] : 0;
    const bv = i < b.length ? b[i] : 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

class GameEngine {
  /**
   * @param {number} playerCount - always 4 for T42
   * @param {number} maxPip - always 6 for double-6 set
   * @param {number} handSize - always 7 for T42
   */
  constructor(playerCount = 4, maxPip = 6, handSize = 7) {
    this.playerCount = Number(playerCount);
    this.maxPip = Number(maxPip);
    this.handSize = Number(handSize);

    // Trump state
    this.trumpSuit = null;        // null, number (0-6), or 'DOUBLES'
    this.trumpMode = 'NONE';      // 'NONE', 'PIP', 'DOUBLES'

    // Players
    this.activePlayers = Array.from({ length: this.playerCount }, (_, i) => i);

    // Hand data
    this.hands = [];              // hands[seat] = [[high,low], ...]
    this.leader = 0;
    this.currentPlayer = 0;
    this.currentTrick = [];       // [[seat, [high,low]], ...]
    this.tricksTeam = [[], []];   // tricksTeam[teamIdx] = [record, ...]
    this.teamPoints = [0, 0];     // honor points + trick counts
    this.trickNumber = 0;

    // Nello / special flags
    this.nelloDoublesSuit = false;
    this.forceDoubleTrump = false;
  }

  // ----------------------------------------------------------
  // Setup
  // ----------------------------------------------------------

  /**
   * Set dealt hands and the starting leader.
   */
  setHands(hands, leader = 0) {
    this.hands = hands.map(h =>
      (h || []).map(t => [Number(t[0]), Number(t[1])])
    );
    this.leader = ((Number(leader) % this.playerCount) + this.playerCount) % this.playerCount;
    this.currentPlayer = this.leader;
    this.currentTrick = [];
    this.tricksTeam = [[], []];
    this.teamPoints = [0, 0];
    this.trickNumber = 0;
  }

  /**
   * Set the trump suit and mode.
   * @param {null|number|string} trump - null for NT, 0-6 for pip, 'DOUBLES'
   * @param {'NONE'|'PIP'|'DOUBLES'} mode - optional explicit mode
   */
  setTrump(trump, mode) {
    if (mode) {
      this.trumpMode = mode;
      this.trumpSuit = trump;
      return;
    }
    if (trump === null || trump === undefined) {
      this.trumpSuit = null;
      this.trumpMode = 'NONE';
    } else if (typeof trump === 'string' && trump.toUpperCase() === 'DOUBLES') {
      this.trumpSuit = 'DOUBLES';
      this.trumpMode = 'DOUBLES';
    } else {
      this.trumpSuit = Number(trump);
      this.trumpMode = 'PIP';
    }
  }

  /**
   * Set which players are active (for Nello where partner sits out).
   */
  setActivePlayers(players) {
    const valid = (players || [])
      .map(p => Number(p))
      .filter(p => Number.isFinite(p) && p >= 0 && p < this.playerCount);
    this.activePlayers = valid.length
      ? valid
      : Array.from({ length: this.playerCount }, (_, i) => i);
  }

  // ----------------------------------------------------------
  // Team / tile helpers
  // ----------------------------------------------------------

  /** Team index: seats 0+2 = team 0, seats 1+3 = team 1 */
  teamOf(seat) {
    return Number(seat) % 2;
  }

  /** Is this tile a trump tile? */
  _isTrumpTile(tile) {
    if (this.trumpMode === 'NONE') return false;
    if (this.trumpMode === 'DOUBLES') return tile[0] === tile[1];
    return tile[0] === this.trumpSuit || tile[1] === this.trumpSuit;
  }

  _isDouble(tile) {
    return tile[0] === tile[1];
  }

  /** Normalize current trick entries */
  _sanitizedTrick() {
    const out = [];
    for (const entry of this.currentTrick) {
      const seat = Number(entry[0]);
      const t = entry[1];
      if (Array.isArray(t) && t.length === 2) {
        out.push([seat, [Number(t[0]), Number(t[1])]]);
      }
    }
    return out;
  }

  /** Next active player after cur (clockwise). */
  _nextActivePlayer(cur) {
    let p = Number(cur);
    for (let i = 0; i < this.playerCount; i++) {
      p = (p + 1) % this.playerCount;
      if (this.activePlayers.includes(p)) return p;
    }
    return Number(cur);
  }

  // ----------------------------------------------------------
  // Led-suit determination
  // ----------------------------------------------------------

  /**
   * Returns the led suit for the current trick:
   *  -2  = nello-doubles-as-suit (doubles are their own suit)
   *  -1  = trump was led
   *  0-6 = pip suit led
   *  null = trick is empty (leader plays anything)
   */
  _ledSuitForTrick() {
    const trick = this._sanitizedTrick();
    if (!trick.length) return null;
    const [, leadTile] = trick[0];
    // Nello doubles-as-suit: if lead tile is a double, led suit is -2
    if (this.nelloDoublesSuit && this._isDouble(leadTile)) return -2;
    // If lead tile is trump, led suit is trump (-1)
    if (this._isTrumpTile(leadTile)) return -1;
    // Otherwise led suit is the higher pip
    return Math.max(leadTile[0], leadTile[1]);
  }

  // ----------------------------------------------------------
  // Legal move computation (CRITICAL — ported exactly from game.js)
  // ----------------------------------------------------------

  /**
   * Returns array of valid hand indices for the given seat.
   *
   * Follow-suit rules:
   *
   * PIP trump mode (e.g., 5s are trump):
   * - Trump led (-1): must play trump if you have any
   * - Pip suit led (e.g., 3): must play a tile with 3 that is NOT a trump
   *   Exception: if lead tile IS trump (e.g., [5,3] when 5s trump), it's trump lead
   *
   * DOUBLES trump mode:
   * - All doubles are trump
   * - Double led: must play a double if you have one
   * - Non-double led: follow the higher pip (excluding doubles/trump)
   */
  legalIndicesForPlayer(seat) {
    const p = Number(seat);
    if (!(p >= 0 && p < this.playerCount)) return [];
    if (!this.activePlayers.includes(p)) return [];
    const hand = this.hands[p] || [];
    if (!hand.length) return [];

    const suit = this._ledSuitForTrick();

    // No lead yet — anything is legal
    if (suit === null) return Array.from({ length: hand.length }, (_, i) => i);

    // --- Nello doubles-as-suit: doubles were led ---
    if (suit === -2) {
      const dblIdx = [];
      for (let i = 0; i < hand.length; i++) {
        if (this._isDouble(hand[i])) dblIdx.push(i);
      }
      return dblIdx.length ? dblIdx : Array.from({ length: hand.length }, (_, i) => i);
    }

    // --- Trump was led ---
    if (suit === -1) {
      const trumpIdx = [];
      for (let i = 0; i < hand.length; i++) {
        if (this._isTrumpTile(hand[i])) trumpIdx.push(i);
      }
      // Call for double: force double trump if active
      if (this.forceDoubleTrump) {
        const forcedIdx = trumpIdx.filter(i => this._isDouble(hand[i]));
        if (forcedIdx.length) return forcedIdx;
      }
      return trumpIdx.length ? trumpIdx : Array.from({ length: hand.length }, (_, i) => i);
    }

    // --- A pip suit was led (0-6) ---
    const suitIdx = [];
    for (let i = 0; i < hand.length; i++) {
      const t = hand[i];
      // In nello doubles-as-suit mode, doubles don't follow regular pip suits
      if (this.nelloDoublesSuit && this._isDouble(t)) continue;
      // Must contain the led pip AND must NOT be a trump tile
      if (tileContainsPip(t, Number(suit)) && !this._isTrumpTile(t)) {
        suitIdx.push(i);
      }
    }
    return suitIdx.length ? suitIdx : Array.from({ length: hand.length }, (_, i) => i);
  }

  // ----------------------------------------------------------
  // Play a tile
  // ----------------------------------------------------------

  /**
   * Play a tile from a player's hand.
   * @param {number} seat - player seat
   * @param {number} handIndex - index into that player's hand
   * @returns {{ tile, trickComplete, trickWinner, trickRecord }}
   */
  playTile(seat, handIndex) {
    const p = Number(seat);
    if (p !== this.currentPlayer) {
      throw new IllegalMoveError('Not your turn.');
    }
    if (!this.activePlayers.includes(p)) {
      throw new IllegalMoveError('Player is not active.');
    }
    if (!(p >= 0 && p < this.hands.length)) {
      throw new IllegalMoveError('Bad player.');
    }
    const hand = this.hands[p];
    if (!(handIndex >= 0 && handIndex < hand.length)) {
      throw new IllegalMoveError('Bad index.');
    }
    const legal = this.legalIndicesForPlayer(p);
    if (!legal.includes(handIndex)) {
      throw new IllegalMoveError('Must follow suit if possible.');
    }

    // Remove tile from hand
    let tile = hand.splice(handIndex, 1)[0];
    tile = [Number(tile[0]), Number(tile[1])];
    this.currentTrick.push([p, tile]);

    // Check if trick is complete (all active players have played)
    if (this._sanitizedTrick().length >= this.activePlayers.length) {
      const winner = this.determineTrickWinner();
      const team = this.teamOf(winner);

      // Build a record: record[seat] = tile played (or null)
      const record = Array.from({ length: this.playerCount }, () => null);
      for (const [pi, t] of this._sanitizedTrick()) {
        record[pi] = t;
      }
      this.tricksTeam[team].push(record);
      this.teamPoints[team] += this._scoreTrick(record);

      this.trickNumber += 1;
      this.leader = Number(winner);
      this.currentPlayer = Number(winner);

      const result = {
        tile,
        trickComplete: true,
        trickWinner: Number(winner),
        trickRecord: record,
      };

      // Reset current trick for next round
      this.currentTrick = [];

      return result;
    }

    // Not complete — advance to next player
    this.currentPlayer = this._nextActivePlayer(this.currentPlayer);
    return {
      tile,
      trickComplete: false,
      trickWinner: null,
      trickRecord: null,
    };
  }

  // ----------------------------------------------------------
  // Trick winner determination (ported exactly from game.js)
  // ----------------------------------------------------------

  /**
   * Determine who wins the current trick.
   * - Trump beats non-trump
   * - Double of suit is highest in that suit
   * - Among same suit: higher off-pip wins
   * - Among trumps: double-trump highest, then by off-pip
   */
  determineTrickWinner() {
    const trick = this._sanitizedTrick();
    if (!trick.length) return this.currentPlayer;

    const ledSuit = this._ledSuitForTrick();

    // Nello doubles-as-suit: if doubles were led, highest double wins
    if (ledSuit === -2) {
      let bestP = trick[0][0];
      let bestPip = -1;
      for (const [p, t] of trick) {
        if (this._isDouble(t) && t[0] > bestPip) {
          bestPip = t[0];
          bestP = p;
        }
      }
      return Number(bestP);
    }

    // Check for any trump plays
    const trumps = trick.filter(([, t]) => this._isTrumpTile(t));
    if (trumps.length) {
      let [bestP, bestT] = trumps[0];
      let bestR = this._trumpRank(bestT);
      for (let i = 1; i < trumps.length; i++) {
        const [p, t] = trumps[i];
        const r = this._trumpRank(t);
        if (lexGreater(r, bestR)) {
          bestR = r;
          bestP = p;
        }
      }
      return Number(bestP);
    }

    // No trumps played — highest in led suit wins
    if (ledSuit === null || ledSuit === -1) return Number(trick[0][0]);

    let bestP = trick[0][0];
    let bestR = [-1, -1];
    for (const [p, t] of trick) {
      if (!tileContainsPip(t, Number(ledSuit))) continue;
      if (this._isTrumpTile(t)) continue;
      // Nello doubles-as-suit: doubles don't count as pip suit followers
      if (this.nelloDoublesSuit && this._isDouble(t)) continue;
      const r = this._suitRank(t, Number(ledSuit));
      if (lexGreater(r, bestR)) {
        bestR = r;
        bestP = p;
      }
    }
    return Number(bestP);
  }

  // ----------------------------------------------------------
  // Ranking helpers
  // ----------------------------------------------------------

  /**
   * Rank a tile within a pip suit.
   * Double of the suit = [1, 0] (highest).
   * Otherwise [0, off-pip].
   */
  _suitRank(tile, suit) {
    const a = tile[0], b = tile[1], s = Number(suit);
    if (a === s && b === s) return [1, 0]; // double of suit — highest
    const other = (a === s) ? b : a;
    return [0, Number(other)];
  }

  /**
   * Rank a trump tile for comparison.
   * DOUBLES mode: [1, pipValue] for doubles, [-1,-1] otherwise
   * PIP mode: double-trump [1,0] highest, then [0, off-pip]
   */
  _trumpRank(tile) {
    const a = tile[0], b = tile[1];
    if (this.trumpMode === 'DOUBLES') {
      if (a === b) return [1, a];
      return [-1, -1];
    } else if (this.trumpMode === 'PIP') {
      const t = Number(this.trumpSuit);
      if (a === t && b === t) return [1, 0]; // double-trump — highest
      const other = (a === t) ? b : a;
      return [0, Number(other)];
    }
    return [-1, -1];
  }

  // ----------------------------------------------------------
  // Scoring
  // ----------------------------------------------------------

  /**
   * Score a completed trick record.
   * 1 point per trick + honor points from tiles.
   */
  _scoreTrick(record) {
    let pts = 1; // 1 point for winning the trick
    for (const t of record) {
      if (!t) continue;
      pts += countPoints(t);
    }
    return pts;
  }

  /**
   * Score a trick using countPoints externally (alias for test access).
   */
  scoreTrick(record) {
    return this._scoreTrick(record);
  }

  // ----------------------------------------------------------
  // Hand state
  // ----------------------------------------------------------

  /** Is the hand over? (all 7 tricks played) */
  handIsOver() {
    let total = 0;
    for (let t = 0; t < this.tricksTeam.length; t++) {
      total += this.tricksTeam[t].length;
    }
    return total >= this.handSize;
  }

  /** Return full game state as a plain object. */
  snapshot() {
    return {
      hands: this.hands.map(h => h.map(t => [t[0], t[1]])),
      currentPlayer: this.currentPlayer,
      leader: this.leader,
      currentTrick: this.currentTrick.map(([p, t]) => [Number(p), [t[0], t[1]]]),
      tricksTeam: this.tricksTeam,
      teamPoints: this.teamPoints.slice(),
      trickNumber: this.trickNumber,
      trumpSuit: this.trumpSuit,
      trumpMode: this.trumpMode,
      activePlayers: this.activePlayers.slice(),
      handSize: this.handSize,
      playerCount: this.playerCount,
    };
  }
}

module.exports = { GameEngine, IllegalMoveError };
