/**
 * Builds lightweight navigation metadata for merged platforms.
 * @param {{platforms: Array<{x:number,y:number,w:number,h:number}>}} input
 * @returns {{nodes: Array<any>, byPlatform: Map<any, any>, adjacencyCache: Map<string, Map<number, Array<any>>>, routeCache: Map<string, Array<any> | null>}}
 */
function buildPlatformNavigation(input) {
  const platforms = Array.isArray(input.platforms) ? input.platforms : [];
  const nodes = platforms.map((platform, id) => ({
    id,
    platform,
    leftX: platform.x,
    rightX: platform.x + platform.w,
    centerX: platform.x + platform.w / 2,
    topY: platform.y,
  }));

  const byPlatform = new Map();
  for (const node of nodes) {
    byPlatform.set(node.platform, node);
  }

  return {
    nodes,
    byPlatform,
    adjacencyCache: new Map(),
    routeCache: new Map(),
  };
}

module.exports = { buildPlatformNavigation };
