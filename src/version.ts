/**
 * Single source of truth for the build version — used by the MCP server id,
 * the `/health` readiness payload, and the `remembra_info` metric.
 * package.json is kept in sync by a test (phase7).
 */
export const VERSION = "4.7.0";
