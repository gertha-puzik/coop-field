/**
 * coop-field room server — thin entry point since W4 (behavior-preserving
 * carve): the HTTP server, the WebSocket accept path and every domain handler
 * now live in server/ modules. This file only composes them and starts the
 * transport. Wire contract: AGENTS.md «Room contract»; module map:
 * docs/ARCHITECTURE.md §2. `node server.js` remains the start/deploy unit.
 */
import { startServer } from "./server/net.js";

startServer();
