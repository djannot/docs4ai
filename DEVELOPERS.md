# Docs4ai Developer Guide

This guide covers development setup, packaging, model details, and reference material.

## Development

```bash
# Install dependencies
npm install

# Rebuild native modules for Electron
npm run rebuild

# Run in development mode
npm run dev

# Build TypeScript only
npm run build
```

## Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage

# Single test file
npm test -- tests/processor.test.ts
```

## Building for Distribution

### Generate Icons (optional, for custom builds)

```bash
# Install dependencies (macOS)
brew install librsvg imagemagick

# Generate platform-specific icons (from assets/icon.png or assets/icon.svg)
node scripts/generate-icons.js
```

### Build Installers

```bash
# Build for current platform
npm run package

# Build for specific platform
npm run package:mac    # macOS: .dmg and .zip
npm run package:win:docker  # Windows: .exe installer and portable (Docker)
npm run package:linux  # Linux: AppImage and .deb
```

Built applications are output to the `release/` directory.

## Supported File Types

### Documents

| Extension | Library | Notes |
|-----------|---------|-------|
| `.md` | Built-in | Markdown files |
| `.txt` | Built-in | Plain text |
| `.pdf` | pdf-parse | PDF text extraction |
| `.doc` | word-extractor | Legacy Word documents (97-2003) |
| `.docx` | mammoth | Modern Word documents (2007+) |
| `.odt` | officeparser | OpenDocument Text (LibreOffice, Google Docs) |
| `.rtf` | officeparser | Rich Text Format |
| `.pptx` | officeparser | PowerPoint presentations |
| `.csv` | Built-in | CSV files (Google Sheets export) |

### Web

| Extension | Library | Notes |
|-----------|---------|-------|
| `.html` / `.htm` | turndown | HTML converted to Markdown |

All file parsers are optional dependencies. If not installed, the app provides graceful fallback messages.

Google Docs/Sheets/Slides stored in Drive are exported on demand to supported formats (e.g. Docs -> `.docx`/`.pdf`/`.txt`, Sheets -> `.csv`, Slides -> `.pptx`/`.pdf`).

## Embedding Models

Docs4ai supports local or OpenAI embeddings for indexing and search:

| Provider | Model | Dimensions | Size | Privacy | Best For |
|----------|-------|------------|------|---------|----------|
| **Local Qwen3 Embedding** | Qwen3 Embedding | 1024 | ~639MB | On-device | Private, offline indexing *(Recommended)* |
| **OpenAI** | text-embedding-3-large | 3072 | Cloud | Remote | Highest quality semantic search |

**Notes:**
- Local models download on first use and can run offline.
- OpenAI requires an API key and internet access.
- Changing embedding providers requires clearing and re-syncing your database (different vector dimensions).
- For most users: start with local; switch to OpenAI for maximum quality.

## Chat LLM Options

| Provider | Model | Size | Privacy | Best For |
|----------|-------|------|---------|----------|
| **Local Qwen3** | 1.7B | ~1GB | On-device | Fast, private chat on modest hardware |
| **Local Qwen3** | 4B | ~2.5GB | On-device | Better answer quality with more local compute |
| **OpenAI** | Configurable | Cloud | Remote | Best quality with cloud models |

**Notes:**
- Local models download on first use and can run offline.
- OpenAI requires an API key and internet access.
- For most users: start with local 1.7B; upgrade to 4B for better quality.

## Hybrid Search

Docs4ai uses hybrid search to combine exact keyword matching (FTS5) with semantic vector similarity (sqlite-vec). Results are fused with Reciprocal Rank Fusion (RRF) using k=60:

```text
score = 1 / (60 + rank_fts) + 1 / (60 + rank_vector)
```

This keeps part numbers and exact phrases accurate while still surfacing conceptually related documents.

## Database Schema

Creates a proper `vec0` virtual table compatible with sqlite-vec. Vector dimensions adapt based on your chosen embedding provider:

```sql
CREATE VIRTUAL TABLE vec_items USING vec0(
    embedding FLOAT[dimension],  -- 1024 (Qwen3 Embedding) or 3072 (OpenAI)
    heading_hierarchy TEXT,
    section TEXT,
    chunk_id TEXT UNIQUE,
    content TEXT,
    url TEXT,
    hash TEXT,
    chunk_index INTEGER,
    total_chunks INTEGER
)
```

The database schema automatically adjusts to match your selected embedding provider's output dimensions.

An FTS5 table keeps keyword search fast and is kept in sync with vector data:

```sql
CREATE VIRTUAL TABLE fts_chunks USING fts5(
    content,
    section,
    heading_hierarchy,
    url,
    chunk_id UNINDEXED
)
```

The Knowledge Map stores 2D coordinates in a separate table:

```sql
CREATE TABLE chunk_coords (
    chunk_id TEXT PRIMARY KEY,
    x REAL,
    y REAL
)
```

## Google Drive sync

Docs4ai does not ship Google OAuth credentials. To enable Drive sync, bring your own:

Quickstart: https://developers.google.com/drive/api/quickstart/nodejs

1. Create a Google Cloud project.
2. Enable the Google Drive API.
3. Configure the OAuth consent screen (External is fine for personal use).
4. If the app is in Testing, add your Google account under Test users.
5. Create OAuth Client ID credentials (Application type: Desktop app).
6. Set these environment variables before launching the app:

```bash
export GOOGLE_DRIVE_CLIENT_ID="your-client-id"
export GOOGLE_DRIVE_CLIENT_SECRET="your-client-secret"
```

Then in a profile:

1. Select **Google Drive folder** as the sync source.
2. Click **Connect** to authorize your Google account.
3. Browse and select a folder (My Drive or Shared Drives).
4. Start syncing.

Drive content is cached under your app data directory (e.g. `~/Library/Application Support/docs4ai/drive-cache/<profileId>` on macOS). Search results link back to the Drive file.

## Technical Stack

- **Electron** - Cross-platform native app framework
- **better-sqlite3** - Fast SQLite database access
- **sqlite-vec** - Vector similarity search extension
- **chokidar** - Efficient file system monitoring
- **@huggingface/transformers** - Local embedding model inference
- **OpenAI API** - Optional cloud embedding generation
- **TypeScript** - Type-safe development
- **Express** - Built-in MCP server
- **i18next** - Internationalization framework

## Troubleshooting

### Native module errors

```bash
npm run rebuild
```

### Permission errors on npm install

```bash
sudo chown -R $(whoami) ~/.npm
npm install
```

### Document extraction not working

File format parsers are optional dependencies. Install them explicitly if needed:

```bash
# Install all format parsers
npm install pdf-parse word-extractor mammoth officeparser

# Or install individually
npm install pdf-parse      # For PDF files
npm install word-extractor  # For .doc files
npm install mammoth         # For .docx files
npm install officeparser    # For .pptx, .rtf, .odt files
```

### Local embedding models not downloading

Local models download automatically on first use. Ensure you have:

- Stable internet connection
- Sufficient disk space (~23MB to 1.1GB per model)
- Write permissions in the app directory

If downloads fail, try:

1. Restart the app
2. Check firewall/proxy settings
3. Try a different embedding provider
