const fs = require('fs');
const path = require('path');

/**
 * Picks a random character from static/assets/characters.
 * Why: Keep behavior similar to Python discover_characters + get_random_character.
 * @param {{state: any}} input
 * @returns {{character: string}}
 */
function loadCharacters(input) {
  const baseDir = path.join(input.state.config?.staticDir ?? '', 'assets', 'characters');

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    if (names.length === 0) {
      return { character: 'spartan' };
    }

    const idx = Math.floor(Math.random() * names.length);
    return { character: names[idx] };
  } catch {
    return { character: 'spartan' };
  }
}

module.exports = { loadCharacters };
