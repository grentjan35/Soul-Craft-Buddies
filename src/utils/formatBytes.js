/**
 * Formats a byte count into a human-readable string (KB, MB, GB).
 * @param {number} bytes - The number of bytes to format
 * @returns {string} Formatted string like "1.5 KB" or "2.3 MB"
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const threshold = 1024;
  let unitIndex = 0;
  let value = bytes;

  while (value >= threshold && unitIndex < units.length - 1) {
    value /= threshold;
    unitIndex++;
  }

  const formattedValue = value.toFixed(2);
  return `${formattedValue} ${units[unitIndex]}`;
}

module.exports = { formatBytes };
