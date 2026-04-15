function emitProgressionNotification(io, targetSid, payload) {
  if (!io || !targetSid) {
    return;
  }

  io.to(targetSid).emit('progression_notification', {
    message: String(payload?.message ?? ''),
    type: String(payload?.type ?? 'info'),
    title: String(payload?.title ?? ''),
    caption: String(payload?.caption ?? ''),
    xp: Number.isFinite(payload?.xp) ? payload.xp : 0,
    victimName: payload?.victimName ?? null,
    killerName: payload?.killerName ?? null,
    weapon: payload?.weapon ?? null,
    timestamp: Date.now(),
  });
}

module.exports = {
  emitProgressionNotification,
};
