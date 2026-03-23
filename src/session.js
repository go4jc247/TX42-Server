'use strict';

// ============================================================
// TX42-Server — session.js
// Ported from SessionV6_4g in TX-Dom-Dev game.js
// Manages full game lifecycle: bidding, trump, play, scoring
// ============================================================

const { GameEngine, IllegalMoveError } = require('./game-engine');
const { generateSet, shuffle, tileEquals, tileContainsPip } = require('./tiles');

// Game phases
const PHASE = {
  LOBBY: 'LOBBY',
  DEALING: 'DEALING',
  NEED_BID: 'NEED_BID',
  NEED_TRUMP: 'NEED_TRUMP',
  PLAYING: 'PLAYING',
  HAND_PAUSE: 'HAND_PAUSE',
  GAME_OVER: 'GAME_OVER',
};

class Session {
  /**
   * @param {number} marksToWin - marks needed to win the game (default 7)
   */
  constructor(marksToWin = 7) {
    this.marksToWin = Number(marksToWin);
    this.game = new GameEngine(4, 6, 7);
    this.phase = PHASE.LOBBY;
    this.teamMarks = [0, 0];
    this.dealer = -1;          // Will be 0 after first startGame call rotates
    this.handNumber = 0;

    // Bid state
    this.currentBid = 0;
    this.bidMarks = 1;
    this.bidWinnerSeat = null;
    this.contract = 'NORMAL';  // 'NORMAL' or 'NELLO'

    // Bidding round state
    this.currentBidder = null;
    this.highBid = 0;
    this.highBidder = null;
    this.highMarks = 1;
    this.passCount = 0;
    this.bidderOrder = [];
    this.biddingDone = false;
  }

  // ----------------------------------------------------------
  // Game lifecycle
  // ----------------------------------------------------------

  /** Start a new game from scratch. */
  startGame() {
    this.teamMarks = [0, 0];
    this.handNumber = 0;
    this.dealer = -1; // dealNewHand will rotate to 0
    this.dealNewHand();
  }

  /** Shuffle, deal, and begin bidding for a new hand. */
  dealNewHand() {
    this.contract = 'NORMAL';
    this.currentBid = 0;
    this.bidMarks = 1;
    this.bidWinnerSeat = null;
    this.handNumber++;

    // Rotate dealer clockwise
    this.dealer = (this.dealer + 1) % 4;

    // Generate and shuffle a double-6 set
    const pool = generateSet();
    shuffle(pool);

    // Deal 7 tiles to each of 4 players
    const hands = [];
    let idx = 0;
    for (let p = 0; p < 4; p++) {
      hands.push(pool.slice(idx, idx + 7));
      idx += 7;
    }

    // Set hands in game engine — leader will be set after bidding
    this.game.setHands(hands, 0);
    this.game.setTrump(null);
    this.game.setActivePlayers([0, 1, 2, 3]);

    // Initialize bidding
    this._initBidding();
    this.phase = PHASE.NEED_BID;
  }

  /** Initialize the bidding round state. */
  _initBidding() {
    // First bidder is to the RIGHT of the dealer (dealer-1, clockwise)
    // In the client code, firstBidder = (dealer - 1 + pc) % pc
    // But looking more carefully, the client uses (dealerSeat - 1 + _pc) % _pc
    // which gives the player to the dealer's RIGHT (counter-clockwise from dealer)
    // Actually in 42, first bid goes to player left of dealer = dealer + 1
    // Let me check: client code says (dealerSeat - 1 + _pc) % _pc
    // For dealer=0, that's (0-1+4)%4 = 3. So seat 3 bids first.
    // This is the player to the right of dealer (in clockwise seating).
    // But standard 42 has first bid going to left of dealer.
    // We'll match the client code exactly.
    const firstBidder = (this.dealer - 1 + 4) % 4;

    this.currentBidder = firstBidder;
    this.highBid = 0;
    this.highBidder = null;
    this.highMarks = 1;
    this.passCount = 0;
    this.biddingDone = false;

    // Build bidder order: starting from firstBidder, go around
    this.bidderOrder = [];
    for (let i = 0; i < 4; i++) {
      this.bidderOrder.push((firstBidder + i) % 4);
    }
  }

  // ----------------------------------------------------------
  // Bidding
  // ----------------------------------------------------------

  /**
   * Process a bid from a player.
   * @param {number} seat - bidder's seat
   * @param {number} bid - bid amount (30-42)
   * @param {number} marks - marks wagered (default 1)
   * @returns {{ valid, biddingDone, nextBidder, redeal, bidWinner, winningBid, winningMarks }}
   */
  processBid(seat, bid, marks = 1) {
    if (this.phase !== PHASE.NEED_BID) {
      return { valid: false, reason: 'Not in bidding phase' };
    }
    if (seat !== this.currentBidder) {
      return { valid: false, reason: 'Not your turn to bid' };
    }
    if (bid <= this.highBid && !(marks > this.highMarks)) {
      return { valid: false, reason: 'Bid must be higher than current high bid' };
    }

    this.highBid = bid;
    this.highBidder = seat;
    this.highMarks = marks || 1;

    return this._advanceBidding();
  }

  /**
   * Process a pass from a player.
   * @param {number} seat - passer's seat
   * @returns {{ valid, biddingDone, nextBidder, redeal, bidWinner, winningBid, winningMarks }}
   */
  processPass(seat) {
    if (this.phase !== PHASE.NEED_BID) {
      return { valid: false, reason: 'Not in bidding phase' };
    }
    if (seat !== this.currentBidder) {
      return { valid: false, reason: 'Not your turn to bid' };
    }

    this.passCount++;
    return this._advanceBidding();
  }

  /**
   * Advance to the next bidder or finalize bidding.
   */
  _advanceBidding() {
    const currentIndex = this.bidderOrder.indexOf(this.currentBidder);
    const nextIndex = currentIndex + 1;

    if (nextIndex >= this.bidderOrder.length) {
      // All players have bid — finalize
      return this._finalizeBidding();
    }

    this.currentBidder = this.bidderOrder[nextIndex];
    return {
      valid: true,
      biddingDone: false,
      nextBidder: this.currentBidder,
    };
  }

  /**
   * Finalize bidding round.
   */
  _finalizeBidding() {
    this.biddingDone = true;

    if (this.highBidder === null) {
      // Everyone passed — redeal
      return {
        valid: true,
        biddingDone: true,
        redeal: true,
        bidWinner: null,
        winningBid: 0,
        winningMarks: 0,
      };
    }

    // Record the winning bid
    this.currentBid = this.highBid;
    this.bidMarks = this.highMarks;
    this.bidWinnerSeat = this.highBidder;

    this.phase = PHASE.NEED_TRUMP;

    return {
      valid: true,
      biddingDone: true,
      redeal: false,
      bidWinner: this.highBidder,
      winningBid: this.highBid,
      winningMarks: this.highMarks,
    };
  }

  // ----------------------------------------------------------
  // Trump selection
  // ----------------------------------------------------------

  /**
   * Process trump selection from the bid winner.
   * @param {number} seat - must be bidWinnerSeat
   * @param {null|number|string} trump - null=NT, 0-6=pip, 'DOUBLES', 'NELLO'
   * @param {boolean} nello - true if Nello contract
   * @returns {{ valid, reason? }}
   */
  processTrump(seat, trump, nello = false) {
    if (this.phase !== PHASE.NEED_TRUMP) {
      return { valid: false, reason: 'Not in trump selection phase' };
    }
    if (seat !== this.bidWinnerSeat) {
      return { valid: false, reason: 'Only bid winner can choose trump' };
    }

    const bidderSeat = this.bidWinnerSeat;

    if (nello || (typeof trump === 'string' && trump.toUpperCase() === 'NELLO')) {
      // Nello contract: bidder plays alone, partner sits out
      this.contract = 'NELLO';
      this.game.setTrump(null);
      this.game.leader = bidderSeat;
      this.game.currentPlayer = bidderSeat;

      // Partner sits out: partner is seat + 2
      const partnerSeat = (bidderSeat + 2) % 4;
      const activePlayers = [0, 1, 2, 3].filter(s => s !== partnerSeat);
      this.game.setActivePlayers(activePlayers);
      this.game.hands[partnerSeat] = [];

      this.phase = PHASE.PLAYING;
      return { valid: true };
    }

    // Normal contract
    this.contract = 'NORMAL';

    // Convert 'NT' string to null
    let trumpValue = trump;
    if (typeof trump === 'string' && trump.toUpperCase() === 'NT') {
      trumpValue = null;
    }

    this.game.setTrump(trumpValue);
    this.game.setActivePlayers([0, 1, 2, 3]);
    this.game.leader = bidderSeat;
    this.game.currentPlayer = bidderSeat;

    this.phase = PHASE.PLAYING;
    return { valid: true };
  }

  // ----------------------------------------------------------
  // Play
  // ----------------------------------------------------------

  /**
   * Process a tile play from a player.
   * @param {number} seat - player's seat
   * @param {number[]|number} tileOrIndex - [high,low] tile or hand index
   * @returns {{ valid, reason?, tile, trickComplete, trickWinner, trickRecord,
   *             handComplete, handResult, nextPlayer }}
   */
  processPlay(seat, tileOrIndex) {
    if (this.phase !== PHASE.PLAYING) {
      return { valid: false, reason: 'Not in playing phase' };
    }

    // Determine hand index
    let handIndex;
    if (Array.isArray(tileOrIndex)) {
      // Find tile in hand
      const hand = this.game.hands[seat] || [];
      handIndex = -1;
      for (let i = 0; i < hand.length; i++) {
        if (tileEquals(hand[i], tileOrIndex)) {
          handIndex = i;
          break;
        }
      }
      if (handIndex < 0) {
        return { valid: false, reason: 'Tile not in hand' };
      }
    } else {
      handIndex = tileOrIndex;
    }

    // Validate legality
    const legal = this.game.legalIndicesForPlayer(seat);
    if (!legal.includes(handIndex)) {
      return { valid: false, reason: 'Illegal move — must follow suit' };
    }

    // Execute the play
    let playResult;
    try {
      playResult = this.game.playTile(seat, handIndex);
    } catch (e) {
      if (e instanceof IllegalMoveError) {
        return { valid: false, reason: e.message };
      }
      throw e;
    }

    const result = {
      valid: true,
      tile: playResult.tile,
      trickComplete: playResult.trickComplete,
      trickWinner: playResult.trickWinner,
      trickRecord: playResult.trickRecord,
      nextPlayer: this.game.currentPlayer,
      handComplete: false,
      handResult: null,
    };

    // Check for hand end after a trick completes
    if (playResult.trickComplete) {
      const handEnd = this.checkHandEnd();
      if (handEnd) {
        result.handComplete = true;
        result.handResult = handEnd;
      }
    }

    return result;
  }

  // ----------------------------------------------------------
  // Hand end / scoring (ported from SessionV6_4g.maybe_finish_hand)
  // ----------------------------------------------------------

  /**
   * Check if the hand is over and score it.
   * Returns null if hand continues, or a result object if hand is done.
   */
  checkHandEnd() {
    const handComplete = this.game.handIsOver();
    const isSet = this._isSet();
    const isBidMade = this._isBidMade();
    const isNelloCaught = this._nelloCaughtPoint();

    // End early if: set, bid already made, Nello caught, or all tricks played
    if (!isSet && !isBidMade && !isNelloCaught && !handComplete) {
      return null;
    }

    const marksAtStake = this.bidMarks;
    const bidderSeat = this.bidWinnerSeat !== null ? this.bidWinnerSeat : 0;
    const bidderTeamIndex = bidderSeat % 2;
    const defenderTeamIndex = 1 - bidderTeamIndex;
    const bidderPoints = this.game.teamPoints[bidderTeamIndex];

    let status;
    let winnerTeam;

    if (this.contract === 'NELLO') {
      const bidderTricks = this.game.tricksTeam[bidderTeamIndex].length;
      if (bidderTricks === 0) {
        // Nello success: bidder's team won no tricks
        this.teamMarks[bidderTeamIndex] += marksAtStake;
        winnerTeam = bidderTeamIndex;
        status = `Nello success! +${marksAtStake} mark(s) to Team ${bidderTeamIndex + 1}.`;
      } else {
        // Nello failed: bidder won a trick
        this.teamMarks[defenderTeamIndex] += marksAtStake;
        winnerTeam = defenderTeamIndex;
        status = `Nello failed! +${marksAtStake} mark(s) to Team ${defenderTeamIndex + 1}.`;
      }
    } else if (isSet) {
      this.teamMarks[defenderTeamIndex] += marksAtStake;
      winnerTeam = defenderTeamIndex;
      status = `SET! Bid ${this.currentBid}, only ${bidderPoints} possible. +${marksAtStake} mark(s) to Team ${defenderTeamIndex + 1}.`;
    } else {
      if (bidderPoints >= this.currentBid) {
        this.teamMarks[bidderTeamIndex] += marksAtStake;
        winnerTeam = bidderTeamIndex;
        status = `Bid made! ${bidderPoints} points (needed ${this.currentBid}). +${marksAtStake} mark(s) to Team ${bidderTeamIndex + 1}.`;
      } else {
        this.teamMarks[defenderTeamIndex] += marksAtStake;
        winnerTeam = defenderTeamIndex;
        status = `Bid failed! Only ${bidderPoints} points (needed ${this.currentBid}). +${marksAtStake} mark(s) to Team ${defenderTeamIndex + 1}.`;
      }
    }

    // Check for game win
    let gameOver = false;
    let gameWinner = null;
    if (Math.max(this.teamMarks[0], this.teamMarks[1]) >= this.marksToWin) {
      gameOver = true;
      gameWinner = this.teamMarks[0] > this.teamMarks[1] ? 0 : 1;
      status += ` Team ${gameWinner + 1} wins the game!`;
      this.phase = PHASE.GAME_OVER;
    } else {
      this.phase = PHASE.HAND_PAUSE;
    }

    return {
      status,
      winnerTeam,
      teamPoints: this.game.teamPoints.slice(),
      teamMarks: this.teamMarks.slice(),
      marksAwarded: marksAtStake,
      gameOver,
      gameWinner,
    };
  }

  // ----------------------------------------------------------
  // Set / bid-made detection (ported from game.js)
  // ----------------------------------------------------------

  /** Check if the bidding team is set (can't possibly make their bid). */
  _isSet() {
    if (this.contract === 'NELLO') return false;
    const bidderSeat = this.bidWinnerSeat !== null ? this.bidWinnerSeat : 0;
    const bidderTeamIndex = bidderSeat % 2;
    const bidderPoints = this.game.teamPoints[bidderTeamIndex];
    const totalPossible = 42; // T42: 7 tricks + 35 honor points = 42
    const pointsAwarded = this.game.teamPoints[0] + this.game.teamPoints[1];
    const pointsRemaining = totalPossible - pointsAwarded;
    const maxBidderCanGet = bidderPoints + pointsRemaining;
    return maxBidderCanGet < this.currentBid;
  }

  /** Check if bid is already made. */
  _isBidMade() {
    if (this.contract === 'NELLO') return false;
    const bidderSeat = this.bidWinnerSeat !== null ? this.bidWinnerSeat : 0;
    const bidderTeamIndex = bidderSeat % 2;
    return this.game.teamPoints[bidderTeamIndex] >= this.currentBid;
  }

  /** Check if Nello bidder caught a point (won a trick). */
  _nelloCaughtPoint() {
    if (this.contract !== 'NELLO') return false;
    const bidderSeat = this.bidWinnerSeat !== null ? this.bidWinnerSeat : 0;
    const bidderTeamIndex = bidderSeat % 2;
    return this.game.tricksTeam[bidderTeamIndex].length > 0;
  }

  // ----------------------------------------------------------
  // Snapshots
  // ----------------------------------------------------------

  /**
   * Player-specific snapshot — only includes that player's hand.
   */
  playerSnapshot(seat) {
    const g = this.game;
    const snap = {
      phase: this.phase,
      dealer: this.dealer,
      handNumber: this.handNumber,
      currentBid: this.currentBid,
      bidMarks: this.bidMarks,
      bidWinnerSeat: this.bidWinnerSeat,
      contract: this.contract,
      teamMarks: this.teamMarks.slice(),
      marksToWin: this.marksToWin,

      // Game engine state
      currentPlayer: g.currentPlayer,
      leader: g.leader,
      trumpSuit: g.trumpSuit,
      trumpMode: g.trumpMode,
      trickNumber: g.trickNumber,
      activePlayers: g.activePlayers.slice(),
      teamPoints: g.teamPoints.slice(),
      currentTrick: g.currentTrick.map(([p, t]) => [Number(p), [t[0], t[1]]]),

      // Only this player's hand (hide others)
      hand: (g.hands[seat] || []).map(t => [t[0], t[1]]),
      handSizes: g.hands.map(h => h.length),

      // Trick history counts
      tricksTeam: [g.tricksTeam[0].length, g.tricksTeam[1].length],
    };

    // Include bidding state if in NEED_BID phase
    if (this.phase === PHASE.NEED_BID) {
      snap.currentBidder = this.currentBidder;
      snap.highBid = this.highBid;
      snap.highBidder = this.highBidder;
      snap.passCount = this.passCount;
    }

    return snap;
  }

  /**
   * Full snapshot — all hands visible (for observers/debugging).
   */
  fullSnapshot() {
    const g = this.game;
    return {
      phase: this.phase,
      dealer: this.dealer,
      handNumber: this.handNumber,
      currentBid: this.currentBid,
      bidMarks: this.bidMarks,
      bidWinnerSeat: this.bidWinnerSeat,
      contract: this.contract,
      teamMarks: this.teamMarks.slice(),
      marksToWin: this.marksToWin,

      currentPlayer: g.currentPlayer,
      leader: g.leader,
      trumpSuit: g.trumpSuit,
      trumpMode: g.trumpMode,
      trickNumber: g.trickNumber,
      activePlayers: g.activePlayers.slice(),
      teamPoints: g.teamPoints.slice(),
      currentTrick: g.currentTrick.map(([p, t]) => [Number(p), [t[0], t[1]]]),
      hands: g.hands.map(h => h.map(t => [t[0], t[1]])),
      tricksTeam: g.tricksTeam,

      // Bidding state
      currentBidder: this.currentBidder,
      highBid: this.highBid,
      highBidder: this.highBidder,
      passCount: this.passCount,
    };
  }
}

module.exports = { Session, PHASE };
