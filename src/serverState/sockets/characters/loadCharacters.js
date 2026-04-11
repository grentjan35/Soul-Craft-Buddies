const fs = require('fs');
const path = require('path');

/**
 * Lists available character folders from static/assets/characters.
 * @param {{state: any}} input
 * @returns {string[]}
 */
function listCharacters(input) {
  const baseDir = path.join(input.state.config?.staticDir ?? '', 'assets', 'characters');

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const characters = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    
    // Sort with 'blanky' first, then alphabetically
    return characters.sort((a, b) => {
      if (a === 'blanky') return -1;
      if (b === 'blanky') return 1;
      return a.localeCompare(b);
    });
  } catch {
    return [];
  }
}

/**
 * Resolves the requested character if valid, otherwise falls back safely.
 * @param {{state: any, requestedCharacter?: string | null}} input
 * @returns {{character: string, availableCharacters: string[]}}
 */
function resolveCharacterSelection(input) {
  const availableCharacters = listCharacters({ state: input.state });
  const requestedCharacter = String(input.requestedCharacter ?? '').trim().toLowerCase();

  if (requestedCharacter && availableCharacters.includes(requestedCharacter)) {
    return { character: requestedCharacter, availableCharacters };
  }

  if (availableCharacters.length > 0) {
    return { character: availableCharacters[0], availableCharacters };
  }

  return { character: 'spartan', availableCharacters };
}

module.exports = { listCharacters, resolveCharacterSelection };
