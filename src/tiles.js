'use strict';

// ============================================================
// TX42-Server — tiles.js
// Domino tile utilities for double-6 Texas 42
// ============================================================

/**
 * Generate the full double-6 set (28 tiles).
 * Each tile is [high, low] with high >= low.
 */
function generateSet() {
  const tiles = [];
  for (let a = 0; a <= 6; a++) {
    for (let b = 0; b <= a; b++) {
      tiles.push([a, b]);
    }
  }
  return tiles;
}

/**
 * Fisher-Yates in-place shuffle. Returns the same array.
 */
function shuffle(tiles) {
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles;
}

/**
 * Deal tiles into hands.
 * @param {number[][]} tiles - shuffled tile array
 * @param {number} playerCount - number of players (default 4)
 * @param {number} handSize - tiles per hand (default 7)
 * @returns {number[][][]} array of hands
 */
function deal(tiles, playerCount = 4, handSize = 7) {
  const hands = [];
  let idx = 0;
  for (let p = 0; p < playerCount; p++) {
    hands.push(tiles.slice(idx, idx + handSize));
    idx += handSize;
  }
  return hands;
}

/**
 * Count honor points on a tile.
 * [5,5]=10, [6,4]=10, [5,0]=5, [4,1]=5, [3,2]=5, else 0
 */
function countPoints(tile) {
  const s = tile[0] + tile[1];
  if (s === 10) return 10;
  if (s === 5) return 5;
  return 0;
}

/**
 * True if two tiles are the same (regardless of pip order).
 */
function tileEquals(a, b) {
  return (a[0] === b[0] && a[1] === b[1]) ||
         (a[0] === b[1] && a[1] === b[0]);
}

/**
 * Normalized string key for a tile, e.g. "5-3" (higher pip first).
 */
function tileKey(tile) {
  const hi = Math.max(tile[0], tile[1]);
  const lo = Math.min(tile[0], tile[1]);
  return hi + '-' + lo;
}

/**
 * True if the tile contains the given pip on either side.
 */
function tileContainsPip(tile, pip) {
  return tile[0] === pip || tile[1] === pip;
}

module.exports = {
  generateSet,
  shuffle,
  deal,
  countPoints,
  tileEquals,
  tileKey,
  tileContainsPip,
};
