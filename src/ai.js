'use strict';

// ============================================================
// TX42-Server — ai.js
// Smart AI for empty seats — plays real Texas 42 strategy
// ============================================================

const { countPoints, tileContainsPip } = require('./tiles');

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function _isDouble(t) { return t[0] === t[1]; }

function _isTrump(t, trumpSuit, trumpMode) {
  if (trumpMode === 'DOUBLES') return _isDouble(t);
  if (trumpMode === 'PIP') return t[0] === trumpSuit || t[1] === trumpSuit;
  return false;
}

/** Get the "off-pip" of a tile in a pip-trump suit. */
function _offPip(t, suit) {
  if (t[0] === suit && t[1] === suit) return 7; // double is highest
  return t[0] === suit ? t[1] : t[0];
}

/** Partner seat (0↔2, 1↔3). */
function _partner(seat) { return (seat + 2) % 4; }

/** Team index: 0+2=team0, 1+3=team1. */
function _teamOf(seat) { return seat % 2; }

// ------------------------------------------------------------
// BIDDING — Evaluate hand strength for Texas 42
// ------------------------------------------------------------

/**
 * Evaluate a hand for bidding. Returns { shouldBid, suggestedBid }.
 *
 * Strategy based on "Winning 42" principles:
 * - Count sure tricks (doubles in pip mode, walking trump)
 * - Evaluate best trump suit (need double + 2-3 more)
 * - Consider honor tile protection
 * - Position matters: last bidder can be more aggressive
 */
function aiBid(hand, highBid, gameMode) {
  // Evaluate hand for each possible trump
  let bestEval = _evaluateForTrump(hand, 'DOUBLES');
  for (let pip = 0; pip <= 6; pip++) {
    const ev = _evaluateForTrump(hand, pip);
    if (ev.sureTricks > bestEval.sureTricks ||
        (ev.sureTricks === bestEval.sureTricks && ev.strength > bestEval.strength)) {
      bestEval = ev;
    }
  }

  const { sureTricks, strength, honorPoints } = bestEval;

  // Bidding thresholds:
  // 4+ sure tricks with good honors → bid 30-31
  // 5+ sure tricks → bid 31-34
  // 6+ sure tricks → bid 36+
  // 7 sure tricks → bid 42

  if (sureTricks >= 7) {
    const bid = 42;
    if (bid > highBid) return { action: 'bid', bid };
  }

  if (sureTricks >= 6 && strength >= 35) {
    const bid = Math.min(42, Math.max(36, highBid + 1));
    if (bid > highBid) return { action: 'bid', bid };
  }

  if (sureTricks >= 5 && strength >= 28) {
    const bid = Math.max(31, highBid + 1);
    if (bid <= 36 && bid > highBid) return { action: 'bid', bid };
  }

  if (sureTricks >= 4 && strength >= 22) {
    const bid = Math.max(30, highBid + 1);
    if (bid <= 32 && bid > highBid) return { action: 'bid', bid };
  }

  // Marginal hand: bid 30 if nobody else has bid
  if (sureTricks >= 3 && strength >= 18 && highBid === 0) {
    return { action: 'bid', bid: 30 };
  }

  return { action: 'pass' };
}

/**
 * Evaluate a hand assuming a specific trump.
 * Returns { sureTricks, strength, honorPoints, trump }.
 */
function _evaluateForTrump(hand, trump) {
  const isDoublesTrump = trump === 'DOUBLES';
  let sureTricks = 0;
  let strength = 0;
  let honorPoints = 0;

  if (isDoublesTrump) {
    // DOUBLES trump: each double is a trump, ranked by pip value
    const doubles = hand.filter(t => _isDouble(t)).sort((a, b) => b[0] - a[0]);
    const nonDoubles = hand.filter(t => !_isDouble(t));

    // Count trump depth
    const trumpCount = doubles.length;
    if (trumpCount < 4) {
      // Need 4+ doubles to make DOUBLES work
      return { sureTricks: 0, strength: 0, honorPoints: 0, trump };
    }

    // Walking doubles from top: [6,6] is top, then [5,5], etc.
    // If you have [6,6] it walks. If you have [6,6]+[5,5] both walk, etc.
    let topPip = 6;
    for (const d of doubles) {
      if (d[0] === topPip) { sureTricks++; topPip--; }
      else break;
    }

    // Remaining doubles are still strong
    strength += trumpCount * 5;
    strength += sureTricks * 3;

    // Non-doubles: check for pip-suit winners (high tiles in off-suits)
    for (const t of nonDoubles) {
      const pts = countPoints(t);
      honorPoints += pts;
      // High off-suit tiles get credit
      if (t[0] + t[1] >= 9) strength += 2;
    }
  } else {
    // PIP trump (0-6)
    const trumpTiles = hand.filter(t => t[0] === trump || t[1] === trump);
    const nonTrump = hand.filter(t => t[0] !== trump && t[1] !== trump);
    const trumpCount = trumpTiles.length;

    // Need the double of trump suit + depth to be viable
    const hasDoubleTrump = trumpTiles.some(t => _isDouble(t));

    if (trumpCount < 3 || (!hasDoubleTrump && trumpCount < 5)) {
      // Weak trump suit
      return { sureTricks: Math.floor(trumpCount / 3), strength: trumpCount * 2, honorPoints: 0, trump };
    }

    // Sort trump by off-pip descending (double trump = off-pip 7, highest)
    const sorted = trumpTiles.slice().sort((a, b) => _offPip(b, trump) - _offPip(a, trump));

    // Walking trump: double walks, then highest off-pip if sequential
    if (hasDoubleTrump) {
      sureTricks++; // double-trump always wins
      // Max off-pip depends on trump suit: if trump is 6, max off is 5 (no [6,7])
      let nextOff = (trump >= 6) ? 5 : 6;
      for (const t of sorted) {
        if (_isDouble(t)) continue;
        const off = _offPip(t, trump);
        if (off === nextOff) { sureTricks++; nextOff--; }
        else break;
      }
    }

    strength += trumpCount * 4;
    strength += sureTricks * 4;
    if (hasDoubleTrump) strength += 5;

    // Off-suit evaluation: doubles are sure tricks, high tiles help
    for (const t of nonTrump) {
      const pts = countPoints(t);
      honorPoints += pts;
      if (_isDouble(t)) {
        sureTricks++; // off-suit doubles win their suit
        strength += 4;
      } else if (t[0] + t[1] >= 9) {
        strength += 2; // high tile, might win
      }
    }
  }

  // Honor bonus: having honors you can protect is valuable
  strength += Math.floor(honorPoints / 5);

  return { sureTricks, strength, honorPoints, trump };
}

// ------------------------------------------------------------
// TRUMP SELECTION — Pick the best trump suit
// ------------------------------------------------------------

/**
 * Choose trump after winning the bid.
 * Evaluates every possible trump and picks the strongest.
 */
function aiChooseTrump(hand) {
  let bestTrump = 0;
  let bestScore = -1;

  // Evaluate DOUBLES
  const doublesEval = _evaluateForTrump(hand, 'DOUBLES');
  if (doublesEval.sureTricks > bestScore ||
      (doublesEval.sureTricks === bestScore && doublesEval.strength > bestScore)) {
    bestScore = doublesEval.sureTricks;
    bestTrump = 'DOUBLES';
  }

  // Evaluate each pip suit
  for (let pip = 0; pip <= 6; pip++) {
    const ev = _evaluateForTrump(hand, pip);
    if (ev.sureTricks > bestScore ||
        (ev.sureTricks === bestScore && ev.strength > _evaluateForTrump(hand, bestTrump === 'DOUBLES' ? 'DOUBLES' : bestTrump).strength)) {
      bestScore = ev.sureTricks;
      bestTrump = pip;
    }
  }

  return { trump: bestTrump };
}

// ------------------------------------------------------------
// PLAY SELECTION — Real trick-taking strategy
// ------------------------------------------------------------

/**
 * Choose which tile to play. Uses full game context:
 * - Who led, what's been played, who's winning
 * - Partner awareness (don't beat partner)
 * - Honor protection (don't waste count tiles)
 * - Trump management (pull trump when bidder, save trump for defense)
 */
function aiChoosePlay(game, seat) {
  const legal = game.legalIndicesForPlayer(seat);
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0];

  const hand = game.hands[seat];
  const trick = game.currentTrick;
  const isLead = trick.length === 0;
  const trumpSuit = game.trumpSuit;
  const trumpMode = game.trumpMode;
  const partnerSeat = _partner(seat);

  if (isLead) {
    return _chooseLead(hand, legal, game, seat);
  } else {
    return _chooseFollow(hand, legal, game, seat, trick);
  }
}

/**
 * Choose a tile when leading a trick.
 */
function _chooseLead(hand, legal, game, seat) {
  const trumpSuit = game.trumpSuit;
  const trumpMode = game.trumpMode;
  const trickNum = game.trickNumber;

  const trumpTiles = legal.filter(i => _isTrump(hand[i], trumpSuit, trumpMode));
  const nonTrump = legal.filter(i => !_isTrump(hand[i], trumpSuit, trumpMode));

  // Early game (tricks 0-2): lead trump to pull opponent trump
  if (trickNum <= 2 && trumpTiles.length >= 2) {
    // Lead highest trump to pull opponents'
    return _highestTile(hand, trumpTiles, trumpSuit, trumpMode);
  }

  // Lead from a suit where we have the double (sure winner)
  for (const idx of nonTrump) {
    const t = hand[idx];
    if (_isDouble(t)) {
      // This double wins its suit — great lead
      return idx;
    }
  }

  // Lead a strong trump if we still have depth
  if (trumpTiles.length >= 2) {
    return _highestTile(hand, trumpTiles, trumpSuit, trumpMode);
  }

  // Lead lowest non-honor non-trump tile (trash lead)
  const trash = nonTrump.filter(i => countPoints(hand[i]) === 0);
  if (trash.length > 0) {
    return _lowestTile(hand, trash, trumpSuit, trumpMode);
  }

  // Lead lowest available
  return _lowestTile(hand, legal, trumpSuit, trumpMode);
}

/**
 * Choose a tile when following.
 */
function _chooseFollow(hand, legal, game, seat, trick) {
  const trumpSuit = game.trumpSuit;
  const trumpMode = game.trumpMode;
  const partnerSeat = _partner(seat);

  // Who's currently winning the trick?
  const winnerInfo = _currentTrickWinner(trick, game);
  const partnerWinning = winnerInfo && _teamOf(winnerInfo.seat) === _teamOf(seat);

  // How many points are in this trick so far?
  let trickPoints = 0;
  for (const [, t] of trick) {
    trickPoints += countPoints(t);
  }

  // Can we win? Separate legal tiles into winners and losers
  const winners = [];
  const losers = [];
  for (const idx of legal) {
    if (_wouldWinTrick(hand[idx], trick, game)) {
      winners.push(idx);
    } else {
      losers.push(idx);
    }
  }

  // CASE 1: Partner is winning
  if (partnerWinning) {
    // Don't overtake partner — play lowest card
    // Exception: if we can add honor points safely and still let partner win
    if (losers.length > 0) {
      // Play highest honor that doesn't win (adds points to partner's trick)
      const honorLosers = losers.filter(i => countPoints(hand[i]) > 0);
      if (honorLosers.length > 0 && trickPoints > 0) {
        // Dump honor points on partner's winning trick
        return _highestByPoints(hand, honorLosers);
      }
      return _lowestTile(hand, losers, trumpSuit, trumpMode);
    }
    // All our legal plays would win — play lowest winner
    return _lowestTile(hand, winners, trumpSuit, trumpMode);
  }

  // CASE 2: Opponent is winning
  if (winners.length > 0) {
    // We can win — should we?
    const isValuableTrick = trickPoints >= 5 || trick.length === 3; // last to play = valuable

    if (isValuableTrick || trickPoints > 0) {
      // Win with lowest winning tile to conserve strength
      return _lowestTile(hand, winners, trumpSuit, trumpMode);
    }

    // Trick has no honors yet — still try to win cheaply
    // Check if any winner is a non-honor card
    const cheapWinners = winners.filter(i => countPoints(hand[i]) === 0);
    if (cheapWinners.length > 0) {
      return _lowestTile(hand, cheapWinners, trumpSuit, trumpMode);
    }

    // Only honor tiles can win — win if trick is worth it, else dump
    if (losers.length > 0) {
      return _lowestTile(hand, losers, trumpSuit, trumpMode);
    }
    return _lowestTile(hand, winners, trumpSuit, trumpMode);
  }

  // CASE 3: Can't win — minimize damage
  // Don't give opponents honor points: play lowest non-honor
  const nonHonors = legal.filter(i => countPoints(hand[i]) === 0);
  if (nonHonors.length > 0) {
    return _lowestTile(hand, nonHonors, trumpSuit, trumpMode);
  }
  // Only honors left — play lowest honor
  return _lowestByPoints(hand, legal);
}

// ------------------------------------------------------------
// Trick evaluation helpers
// ------------------------------------------------------------

/**
 * Determine who is currently winning the trick in progress.
 * Returns { seat, tile } or null.
 */
function _currentTrickWinner(trick, game) {
  if (trick.length === 0) return null;

  const trumpSuit = game.trumpSuit;
  const trumpMode = game.trumpMode;

  let bestSeat = trick[0][0];
  let bestTile = trick[0][1];
  let bestIsTrump = _isTrump(bestTile, trumpSuit, trumpMode);

  // Led suit determination
  const leadTile = trick[0][1];
  const ledIsTrump = _isTrump(leadTile, trumpSuit, trumpMode);
  let ledSuit;
  if (ledIsTrump) {
    ledSuit = -1; // trump led
  } else {
    ledSuit = Math.max(leadTile[0], leadTile[1]);
  }

  for (let i = 1; i < trick.length; i++) {
    const [s, t] = trick[i];
    const isTrump = _isTrump(t, trumpSuit, trumpMode);

    if (isTrump && !bestIsTrump) {
      // Trump beats non-trump
      bestSeat = s; bestTile = t; bestIsTrump = true;
    } else if (isTrump && bestIsTrump) {
      // Both trump: compare trump rank
      if (_trumpValue(t, trumpSuit, trumpMode) > _trumpValue(bestTile, trumpSuit, trumpMode)) {
        bestSeat = s; bestTile = t;
      }
    } else if (!isTrump && !bestIsTrump) {
      // Neither trump: must follow led suit to win
      if (_followsLedSuit(t, ledSuit, trumpSuit, trumpMode)) {
        if (_suitValue(t, ledSuit) > _suitValue(bestTile, ledSuit)) {
          bestSeat = s; bestTile = t;
        }
      }
    }
    // non-trump can't beat trump — skip
  }

  return { seat: bestSeat, tile: bestTile };
}

/**
 * Would this tile win the trick if played now?
 */
function _wouldWinTrick(tile, trick, game) {
  const trumpSuit = game.trumpSuit;
  const trumpMode = game.trumpMode;

  if (trick.length === 0) return true; // leading always "wins"

  const current = _currentTrickWinner(trick, game);
  if (!current) return true;

  const tileIsTrump = _isTrump(tile, trumpSuit, trumpMode);
  const winnerIsTrump = _isTrump(current.tile, trumpSuit, trumpMode);

  // Led suit
  const leadTile = trick[0][1];
  const ledIsTrump = _isTrump(leadTile, trumpSuit, trumpMode);
  const ledSuit = ledIsTrump ? -1 : Math.max(leadTile[0], leadTile[1]);

  if (tileIsTrump && !winnerIsTrump) return true;
  if (!tileIsTrump && winnerIsTrump) return false;

  if (tileIsTrump && winnerIsTrump) {
    return _trumpValue(tile, trumpSuit, trumpMode) > _trumpValue(current.tile, trumpSuit, trumpMode);
  }

  // Neither is trump
  if (!_followsLedSuit(tile, ledSuit, trumpSuit, trumpMode)) return false;
  return _suitValue(tile, ledSuit) > _suitValue(current.tile, ledSuit);
}

/** Does this tile follow the led suit? */
function _followsLedSuit(tile, ledSuit, trumpSuit, trumpMode) {
  if (ledSuit === -1) return _isTrump(tile, trumpSuit, trumpMode);
  return tileContainsPip(tile, ledSuit) && !_isTrump(tile, trumpSuit, trumpMode);
}

/** Numeric value of a trump tile for comparison. */
function _trumpValue(tile, trumpSuit, trumpMode) {
  if (trumpMode === 'DOUBLES') {
    return _isDouble(tile) ? 100 + tile[0] : -1;
  }
  if (trumpMode === 'PIP') {
    if (_isDouble(tile) && tile[0] === trumpSuit) return 200; // double-trump highest
    if (tile[0] === trumpSuit) return 100 + tile[1];
    if (tile[1] === trumpSuit) return 100 + tile[0];
  }
  return -1;
}

/** Numeric value of a tile within a led suit. */
function _suitValue(tile, ledSuit) {
  if (!tileContainsPip(tile, ledSuit)) return -1;
  if (_isDouble(tile)) return 100; // double of suit is highest
  return tile[0] === ledSuit ? tile[1] : tile[0]; // off-pip value
}

// ------------------------------------------------------------
// Tile selection helpers
// ------------------------------------------------------------

/** Return index of highest-ranked tile from candidates. */
function _highestTile(hand, indices, trumpSuit, trumpMode) {
  let best = indices[0], bestVal = -1;
  for (const i of indices) {
    const t = hand[i];
    let val;
    if (_isTrump(t, trumpSuit, trumpMode)) {
      val = 1000 + _trumpValue(t, trumpSuit, trumpMode);
    } else {
      val = (_isDouble(t) ? 200 : 0) + t[0] + t[1];
    }
    if (val > bestVal) { bestVal = val; best = i; }
  }
  return best;
}

/** Return index of lowest-ranked tile from candidates. */
function _lowestTile(hand, indices, trumpSuit, trumpMode) {
  let best = indices[0], bestVal = Infinity;
  for (const i of indices) {
    const t = hand[i];
    let val;
    if (_isTrump(t, trumpSuit, trumpMode)) {
      val = 1000 + _trumpValue(t, trumpSuit, trumpMode);
    } else {
      val = (_isDouble(t) ? 200 : 0) + t[0] + t[1];
    }
    if (val < bestVal) { bestVal = val; best = i; }
  }
  return best;
}

/** Return index of tile with highest honor points. */
function _highestByPoints(hand, indices) {
  let best = indices[0], bestPts = -1;
  for (const i of indices) {
    const pts = countPoints(hand[i]);
    if (pts > bestPts) { bestPts = pts; best = i; }
  }
  return best;
}

/** Return index of tile with lowest honor points. */
function _lowestByPoints(hand, indices) {
  let best = indices[0], bestPts = Infinity;
  for (const i of indices) {
    const pts = countPoints(hand[i]);
    if (pts < bestPts) { bestPts = pts; best = i; }
  }
  return best;
}

module.exports = { aiBid, aiChooseTrump, aiChoosePlay };
