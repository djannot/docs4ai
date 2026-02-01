# Test Suite

This directory contains unit, integration, and smoke tests for the Docs4ai core capabilities.

## Overview

The test suite validates:
- **Profile Setup**: Creating multiple profiles with separate folders and databases
- **Syncing**: Processing files and storing them in profile-specific databases
- **MCP Server**: Starting independent MCP servers on different ports for each profile
- **Querying**: Verifying that each MCP server can query its own profile's data
- **Independence**: Ensuring profiles operate independently without interference
- **Sync Engine**: File discovery, change events, rename/delete handling, and extension filters
- **Content Processing**: Chunking behavior and HTML sanitization
- **Embeddings**: Provider normalization, invalid API key handling, and local startup failures (mocked)
- **Database**: Persistence, metadata dimension handling, and legacy fallbacks

## Running Tests

### Basic Test Run
```bash
npm test
```

### Watch Mode (for development)
```bash
npm run test:watch
```

### With Coverage
```bash
npm run test:coverage
```

## Test Requirements

### Optional: OpenAI API Key
For full testing including semantic search queries, set the `OPENAI_API_KEY` environment variable:

```bash
export OPENAI_API_KEY=your-api-key-here
npm test
```

**Note**: Tests will run without an API key, but will skip semantic query tests and use zero vectors for embeddings. This allows testing the core functionality without API costs.

## Test Structure

### `multi-profile.integration.test.ts`
Main integration test suite that:
1. Creates two test profiles with different content
2. Syncs files to separate databases
3. Starts MCP servers on different ports
4. Verifies queries return profile-specific results
5. Verifies map endpoints after sync (`/query` with visualization, `/map`, `/neighbors`)
6. Tests profile independence

### `syncer.test.ts`
Folder watcher tests that cover:
- Recursive file discovery and extension filtering
- Add/change/delete events
- Rename handling via add/remove events

### `processor.test.ts`
ContentProcessor coverage for:
- Chunking long content with hierarchy
- HTML sanitization and markdown conversion

### `embeddings.test.ts`
Embedding behavior with mocks:
- Provider normalization
- OpenAI invalid key handling
- Local model startup failure path

### `database.test.ts`
Database safety checks:
- Persistence across reopen
- Metadata-based dimension reuse
- Legacy dimension fallback behavior

### `mcp-server.test.ts`
MCP server coverage for:
- Query responses and metadata
- Query visualization payloads for the Knowledge Map
- Map overview responses
- Neighbor exploration responses
- JSON-RPC error handling
- Missing database behavior

### `profile-smoke.test.ts`
Profile lifecycle smoke test:
- Sync, query, restart, and provider switch with mocked embeddings

### `helpers.ts`
Utility functions for:
- Creating temporary directories and files
- Managing test databases
- Making HTTP requests to MCP servers
- Finding available ports
- Waiting for async conditions

### `setup.ts`
Test setup and teardown:
- Creates per-worker test directories
- Cleans up after tests complete

## Test Data

### Profile 1: Technical Documentation
- `getting-started.md` - Installation and setup guide
- `api-reference.txt` - API endpoint documentation
- `troubleshooting.md` - Common issues and solutions

### Profile 2: Business Documentation
- `business-plan.txt` - Business strategy and goals
- `meeting-notes.md` - Q1 review meeting notes
- `strategy.txt` - Strategic planning document

## What Gets Tested

✅ **Profile Isolation**
- Each profile has its own folder, database, and MCP server
- Data from one profile doesn't appear in another

✅ **File Processing**
- Files are correctly chunked and stored
- Chunks are associated with the correct profile

✅ **MCP Server Independence**
- Each profile's MCP server runs on a separate port
- Queries return results only from that profile's database

✅ **Semantic Search** (with API key)
- Vector embeddings are generated correctly
- Queries return relevant results from the correct profile

✅ **Sync Engine Behavior**
- Watcher events are triggered for add/change/delete/rename
- File extensions and recursion settings are honored

## Troubleshooting

### Tests Fail with Port Errors
If you see port conflicts, ensure no other instances of the app are running:
```bash
# Check for processes using ports 3333-3433
lsof -i :3333-3433
```

### Database Lock Errors
If you see SQLite lock errors, ensure all previous test runs completed:
```bash
# Clean up test databases
rm -rf tests/test-dbs-* tests/temp-*
```

### API Key Errors
If you see embedding generation errors, check your API key:
```bash
echo $OPENAI_API_KEY
```

## Continuous Integration

These tests are designed to run in CI/CD pipelines. They:
- Clean up after themselves
- Use temporary directories that are automatically removed
- Don't require manual intervention
- Can run with or without API keys
