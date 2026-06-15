# Contributing to envpact-mcp

Thanks for your interest! This is part of the
[envpact ecosystem](https://github.com/chirag127/envpact).

## Development

```bash
git clone https://github.com/chirag127/envpact-mcp.git
cd envpact-mcp
npm install
npm test
```

## Testing the Server Locally

Use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node src/index.js
```

Or hand-craft a stdio handshake:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}' | node src/index.js
```

## Pull Requests

1. Fork & branch from `main`.
2. Add tests for any new tool.
3. Run `npm test` and confirm 100% pass.
4. Update `CHANGELOG.md`.
5. Open a PR with a clear description.

## Security Disclosures

Email whyiswhen@gmail.com directly for security issues. Don't open
public issues.
