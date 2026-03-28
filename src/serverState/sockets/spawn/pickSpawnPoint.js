/**
 * Picks a spawn point for the next player.
 * Why: Match the Python round-robin spawn behavior.
 * @param {{state: any}} input
 * @returns {{x: number, y: number}}
 */
function pickSpawnPoint(input) {
  const spawnPoints = Array.isArray(input.state.spawnPoints) ? input.state.spawnPoints : [];
  if (spawnPoints.length === 0) {
    return { x: 100, y: 500 };
  }

  const idx = input.state.spawnPointIndex % spawnPoints.length;
  input.state.spawnPointIndex += 1;

  const spawn = spawnPoints[idx];
  return {
    x: typeof spawn.x === 'number' ? spawn.x : 100,
    y: typeof spawn.y === 'number' ? spawn.y : 500,
  };
}

module.exports = { pickSpawnPoint };
