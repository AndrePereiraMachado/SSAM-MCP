import { sessionGuide } from '../../server-instructions.mjs';
// B1 separately checks that this generated guide travels intact through rules/session on MCP.
export const sessionText = client => client.getInstructions() + ' ' + sessionGuide().replace(/\s+/g, ' ');
