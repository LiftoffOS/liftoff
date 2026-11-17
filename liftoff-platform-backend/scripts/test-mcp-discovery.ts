#!/usr/bin/env npx ts-node
// Test MCP discovery against real MCP servers
// Usage: npx ts-node scripts/test-mcp-discovery.ts [url] [bearer_token]
// Examples:
//   npx ts-node scripts/test-mcp-discovery.ts
//   npx ts-node scripts/test-mcp-discovery.ts https://mcp.linear.app/mcp $LINEAR_API_KEY
//   npx ts-node scripts/test-mcp-discovery.ts https://mcp.asana.com/v2/mcp $ASANA_PAT

import { MCPClient, type MCPClientConfig } from '../src/external-agents/mcp-client';

interface TestEndpoint {
  name: string;
  url: string;
  bearerToken?: string;
}

const defaultEndpoints: TestEndpoint[] = [
  { name: 'CoinGecko', url: 'https://mcp.api.coingecko.com/mcp' },
];

async function testEndpoint(endpoint: TestEndpoint) {
  const { name, url, bearerToken } = endpoint;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${name}`);
  console.log(`URL: ${url}`);
  console.log(`Auth: ${bearerToken ? 'Bearer token provided' : 'None'}`);
  console.log('='.repeat(60));

  const config: MCPClientConfig = {
    endpointUrl: url,
    authType: bearerToken ? 'bearer_token' : 'none',
    bearerToken,
    timeout: 30000,
  };

  const client = new MCPClient(config);

  try {
    console.log('\n1. Starting discovery...');
    const result = await client.discover();

    console.log('\n2. Discovery successful!');
    console.log(`   Transport Type: ${result.transportType}`);
    console.log(`   Server: ${result.serverName} v${result.serverVersion}`);
    console.log(`   Protocol: ${result.protocolVersion}`);
    console.log(`   Tools: ${result.tools.length}`);
    console.log(`   Resources: ${result.resources.length}`);

    if (result.tools.length > 0) {
      console.log('\n3. Tools discovered:');
      for (const tool of result.tools.slice(0, 10)) {
        console.log(`   - ${tool.name}: ${tool.description?.slice(0, 60) || 'No description'}...`);
      }
      if (result.tools.length > 10) {
        console.log(`   ... and ${result.tools.length - 10} more`);
      }
    }

    if (result.resources.length > 0) {
      console.log('\n4. Resources discovered:');
      for (const resource of result.resources.slice(0, 5)) {
        console.log(`   - ${resource.name}: ${resource.description?.slice(0, 60) || 'No description'}...`);
      }
      if (result.resources.length > 5) {
        console.log(`   ... and ${result.resources.length - 5} more`);
      }
    }

    console.log('\n✅ SUCCESS');
    return { success: true, result };
  } catch (error) {
    console.log('\n❌ FAILED');
    console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false, error };
  }
}

async function main() {
  console.log('MCP Discovery Integration Test');
  console.log('Testing shared @liftoffos/mcp-transports package');

  // Check for command line arguments
  const args = process.argv.slice(2);
  let endpoints: TestEndpoint[];

  if (args.length >= 1) {
    // Single endpoint mode with optional bearer token
    const url = args[0];
    const bearerToken = args[1];
    const name = new URL(url).hostname;
    endpoints = [{ name, url, bearerToken }];
  } else {
    // Default: test all endpoints without auth
    endpoints = defaultEndpoints;
    console.log('\nNote: Testing without authentication. Pass URL and token as args:');
    console.log('  npx ts-node scripts/test-mcp-discovery.ts <url> [bearer_token]\n');
  }

  const results: { name: string; success: boolean }[] = [];

  for (const endpoint of endpoints) {
    const result = await testEndpoint(endpoint);
    results.push({ name: endpoint.name, success: result.success });
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`${r.success ? '✅' : '❌'} ${r.name}`);
  }

  const allPassed = results.every(r => r.success);
  process.exit(allPassed ? 0 : 1);
}

main().catch(console.error);
