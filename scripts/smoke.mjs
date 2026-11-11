import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client=new Client({name:'bridge-smoke',version:'1'});
const url=new URL(process.env.BRIDGE_URL || 'http://127.0.0.1:8080/mcp');
await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${process.env.BRIDGE_API_KEY}`}}}));
console.log(JSON.stringify(await client.listTools(),null,2));
console.log(JSON.stringify(await client.callTool({name:'list_projects',arguments:{}}),null,2));
await client.close();
