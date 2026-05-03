// Agent registry barrel. Importing this file registers the built-in
// runners as a side effect — main.ts imports it once at startup so the
// scheduler / API surface can resolve agents by id.

import { registerAgent } from './registry';
import { claudeAgent } from './claude';

registerAgent(claudeAgent);

export { registerAgent, getAgent, listAgents, defaultAgentId } from './registry';
export type { AgentRunner, AgentRunInput, AgentRunResult, AgentId } from './types';
