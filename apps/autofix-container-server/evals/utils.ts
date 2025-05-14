import { MCPClientManager } from 'agents/mcp/client'

export async function initializeClient(): Promise<MCPClientManager> {
	const clientManager = new MCPClientManager('test-client', '0.0.0')
	await clientManager.connect('http://localhost:8976/sse')
	return clientManager
}
