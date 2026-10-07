// Every name the guard shows or uses, in one place.
// To rename: change this file and the "name" / "bin" fields in package.json
// (test/brand.test.mjs checks they agree).

export const BRAND = Object.freeze({
  name: 'TradeAgents Lab',
  short: 'tal', // command name, home folder (~/.tal), env prefix (TAL_HOME)
  site: 'https://tradeagentslab.com',
  npm: '@tradeagentslab/guard',
  mcpName: 'tal-guard', // the name agents see the MCP server under
  skill: 'tal-trader', // the zero-code template's folder name
  arena: 'https://tradeagentslab.com/api/arena/v0',
});

export const ENV_HOME = `${BRAND.short.toUpperCase()}_HOME`;
