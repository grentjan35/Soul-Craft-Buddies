function isPlayerNearPoint(player, x, y, radiusX, radiusY) {
  if (!player || player.is_dying) {
    return false;
  }

  return (
    Number.isFinite(player.x) &&
    Number.isFinite(player.y) &&
    Math.abs(player.x - x) <= radiusX &&
    Math.abs(player.y - y) <= radiusY
  );
}

function emitToNearbyPlayers(input) {
  const {
    io,
    state,
    x,
    y,
    radiusX,
    radiusY,
    event,
    payload,
    includeSids = [],
  } = input;

  if (
    !io ||
    !state ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !(radiusX > 0) ||
    !(radiusY > 0) ||
    !event
  ) {
    return;
  }

  const delivered = new Set();

  for (const sid of includeSids) {
    if (typeof sid !== 'string' || delivered.has(sid)) {
      continue;
    }
    const socket = io.sockets.sockets.get(sid);
    if (!socket) {
      continue;
    }
    socket.emit(event, payload);
    delivered.add(sid);
  }

  for (const [sid, socket] of io.sockets.sockets.entries()) {
    if (delivered.has(sid)) {
      continue;
    }

    const player = state.players.get(sid);
    if (!isPlayerNearPoint(player, x, y, radiusX, radiusY)) {
      continue;
    }

    socket.emit(event, payload);
    delivered.add(sid);
  }
}

module.exports = {
  emitToNearbyPlayers,
  isPlayerNearPoint,
};
