function emitProgressionNotification(io, targetSid, payload) {
  if (!io || !targetSid) {
    return;
  }

  io.to(targetSid).emit('progression_notification', {
    message: String(payload?.message ?? ''),
    type: String(payload?.type ?? 'info'),
    xp: Number.isFinite(payload?.xp) ? payload.xp : 0,
    timestamp: Date.now(),
  });
}

module.exports = {
  emitProgressionNotification,
};
