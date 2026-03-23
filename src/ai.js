'use strict';

// ============================================================
// TX42-Server — ai.js
// Simple AI for empty seats — makes legal moves
// ============================================================

const { countPoints, tileContainsPip } = require('./tiles');

/**
 * AI bid decision. Simple heuristic based on doubles + trump potential.
 */
function aiBid(hand, highBid, gameMode) {
  // Count doubles and find best trump suit
  let doubles = 0;
  const suitCounts = {};
  for (const t of hand) {
    if (t[0] === t[1]) doubles++;
    for (const pip of [t[0], t[1]]) {
      suitCounts[pip] = (suitCounts[pip] || 0) + 1;
    }
  }

  // Find strongest suit
  let bestSuit = -1, bestCount = 0;
  for (const [pip, count] of Object.entries(suitCounts)) {
    if (count > bestCount) { bestCount = count; bestSuit = parseInt(pip); }
  }

  // Evaluate hand strength
  let strength = 0;
  strength += doubles * 5;       // Each double is ~5 points of strength
  strength += bestCount * 4;     // Trump depth
  // Check for count tiles
  for (const t of hand) {
    const pts = countPoints(t);
    if (pts > 0) strength += 2;
  }

  // Decide bid
  if (strength >= 30 && highBid < 36) return { action: 'bid', bid: Math.max(30, highBid + 1) };
  if (strength >= 25 && highBid < 31) return { action: 'bid', bid: Math.max(30, highBid + 1) };
  if (strength >= 20 && highBid === 0) return { action: 'bid', bid: 30 };
  return { action: 'pass' };
}

/**
 * AI trump selection. Pick the suit with the most tiles.
 */
function aiChooseTrump(hand) {
  const suitCounts = {};
  let doubles = 0;
  for (const t of hand) {
    if (t[0] === t[1]) doubles++;
    for (const pip of [t[0], t[1]]) {
      suitCounts[pip] = (suitCounts[pip] || 0) + 1;
    }
  }

  // If 4+ doubles, go no-trump (doubles as trump)
  if (doubles >= 4) return { trump: 'DOUBLES' };

  // Pick suit with most tiles
  let bestSuit = 0, bestCount = 0;
  for (const [pip, count] of Object.entries(suitCounts)) {
    if (count > bestCount) { bestCount = count; bestSuit = parseInt(pip); }
  }
  return { trump: bestSuit };
}

/**
 * AI play selection. Picks a legal tile to play.
 * Simple strategy: lead highest, follow high if can win, dump low if can't.
 */
function aiChoosePlay(game, seat) {
  const legal = game.legalIndicesForPlayer(seat);
  if (legal.length === 0) return null;
  if (legal.length === 1) return legal[0];

  const hand = game.hands[seat];
  const isLead = game.currentTrick.length === 0;

  if (isLead) {
    // Lead: play highest tile (doubles first)
    let bestIdx = legal[0], bestScore = -1;
    for (const idx of legal) {
      const t = hand[idx];
      const score = (t[0] === t[1] ? 100 : 0) + t[0] + t[1];
      if (score > bestScore) { bestScore = score; bestIdx = idx; }
    }
    return bestIdx;
  }

  // Following: try to win with lowest winning tile, else play lowest
  const ledTile = game.currentTrick[0][1];
  let lowestIdx = legal[0], lowestScore = 999;
  let highestIdx = legal[0], highestScore = -1;

  for (const idx of legal) {
    const t = hand[idx];
    const score = t[0] + t[1] + (t[0] === t[1] ? 50 : 0);
    if (score < lowestScore) { lowestScore = score; lowestIdx = idx; }
    if (score > highestScore) { highestScore = score; highestIdx = idx; }
  }

  // Following: play lowest tile (can't easily determine if we'd win)
  return lowestIdx;
}

module.exports = { aiBid, aiChooseTrump, aiChoosePlay };
