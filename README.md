# Docs4ai - Cross-Platform Folder Sync App

A native desktop application that watches a folder and automatically syncs it with a sqlite-vec database. Built with Electron, works on **macOS, Windows, and Linux**.

## Features

- **Real-time folder sync** - Monitors for file additions, modifications, and deletions
- **Google Drive sync** - Index a Drive folder per profile (OAuth, read-only)
- **Incremental sync** - Only processes changed files based on modification time and content hash
- **sqlite-vec integration** - Proper vec0 virtual table for vector similarity search
- **Flexible embeddings** - Choose between local Qwen3 embeddings (free) or OpenAI (paid)
  - Local: Qwen3 Embedding (1024d, ~639MB)
  - OpenAI: text-embedding-3-large (3072d)
- **Cross-platform** - Runs natively on Mac, Windows, and Linux
- **Menu bar/system tray** - Status indicator with sync state
- **Rich file format support** - Documents, presentations, web content, and more
- **Multi-language UI** - Available in 9 languages with instant switching
- **Multiple profiles** - Manage multiple independent sync configurations
- **Built-in MCP server** - Query your documents via HTTP or integrate with AI clients
- **Knowledge Map** - 2D semantic map of results with neighborhood context
- **Chat UI** - Ask questions in-app with document-grounded responses
- **Cost tracking** - Monitor OpenAI token usage and costs in real-time
- **Progress indicators** - Visual feedback for model downloads and file sync operations

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

Google Docs/Sheets/Slides stored in Drive are exported on demand to supported formats (e.g. Docs → `.docx`/`.pdf`/`.txt`, Sheets → `.csv`, Slides → `.pptx`/`.pdf`).

## Requirements

- Node.js 18 or later
- npm
- Google Drive OAuth client ID/secret (optional, only for Drive sync)

## Quick Start

```bash
cd electron-app

# Install dependencies
npm install

# Rebuild native modules for Electron
npm run rebuild

# Build and run
npm start
```

## Development

```bash
# Run in development mode
npm run dev

# Build TypeScript only
npm run build
```

## Building for Distribution

### Generate Icons (optional, for custom builds)

```bash
# Install dependencies (macOS)
brew install librsvg imagemagick

# Generate platform-specific icons
node scripts/generate-icons.js
```

### Build Installers

```bash
# Build for current platform
npm run package

# Build for specific platform
npm run package:mac    # macOS: .dmg and .zip
npm run package:win    # Windows: .exe installer and portable
npm run package:linux  # Linux: AppImage and .deb
```

Built applications are output to the `release/` directory.

## Usage

1. **Launch the app** - Run `npm start` or the built application
2. **Select Language** (optional) - Choose your preferred language from the dropdown in the header
3. **Create/Select Profile** - Use the profile tabs to manage multiple sync configurations
4. **Configure Profile**:
   - **Name** - Give your profile a descriptive name
   - **Sync Source** - Choose **Local folder** or **Google Drive folder** (one per profile)
   - **Watch Folder** - Click "Select..." to choose a folder to monitor (local only)
   - **Google Drive** - Connect your account and browse to a Drive or Shared Drive folder
   - **Database** - Choose where to save the sqlite-vec database
   - **File Extensions** - Check the boxes for file types you want to process
   - **Recursive** - Enable to watch subdirectories
   - **Embedding Provider** - Choose between:
     - **Local Qwen3 Embedding** - High quality local model (1024 dimensions, ~639MB) - **Recommended**
     - **OpenAI** - Highest quality, requires API key (3072 dimensions, paid)
   - **API Key** (OpenAI only) - Enter your OpenAI API key
5. **Click "Start Syncing"** - The app syncs and monitors for changes
6. **Monitor Progress** - Track file processing and model downloads in real-time

### Google Drive Sync

To enable Drive sync, set these environment variables before launching the app:

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

### Multi-Profile Support

The app supports multiple independent profiles, each with its own:
- Watched folder
- Database path
- API key
- File extensions
- MCP server port

Create new profiles using the "+" button in the profile tabs. Switch between profiles by clicking on the tabs.

## Multi-Language Support

Docs4ai supports **9 languages** with instant switching (no restart required):

- 🇬🇧 English
- 🇫🇷 Français (French)
- 🇪🇸 Español (Spanish)
- 🇨🇳 中文 (Chinese/Mandarin)
- 🇮🇳 हिन्दी (Hindi)
- 🇸🇦 العربية (Arabic)
- 🇩🇪 Deutsch (German)
- 🇮🇹 Italiano (Italian)
- 🇵🇹 Português (Portuguese)

Change the language using the dropdown in the header. The UI and tray menu update immediately. Your language preference is saved and persists across app restarts.

## Menu Bar Icon

The app shows a status indicator in the menu bar/system tray:

- **Gray dot** - Not syncing (idle)
- **Green dot** - Syncing (active)
- **Orange dot** - Currently processing a file

Right-click for quick access to status, profile switching, and controls.

## Built-in MCP Server

The app includes a **built-in MCP server** that can be started directly from the UI:

1. Click "Start Server" in the MCP Server section
2. The server runs on the configured port (default: 3333)
3. Query your documents via HTTP

When the MCP server is running, the app also shows a **Configure Clients** panel with setup snippets for popular clients (e.g., VS Code) so you can connect immediately.

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/mcp` | POST | MCP-compatible endpoint |

### Example Query (MCP)

Use the MCP JSON-RPC interface to query documents from external clients.

## Knowledge Map

Docs4ai includes a **Knowledge Map** view that projects all chunks into 2D and highlights the top 5 search results with their semantic neighbors. Open it from the main UI card:

- **Dots** represent document chunks (top results, neighbors, and a sampled global map).
- **Lines** connect adjacent chunks from the same document.
- **Click a dot** to center the map and preview the corresponding chunk.
- **Search** to see the contextual neighborhood around your top results.

## Chat UI

Docs4ai includes a built-in **Chat UI** for asking questions against your synced documents. It works with both **OpenAI** models and **local Qwen3** models:

- **OpenAI**: uses your API key and model selection for high-quality responses.
- **Local Qwen3**: runs entirely on your machine for private, offline-capable chat.

Open the chat panel from the main UI and choose your provider in the chat settings.

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

## Incremental Sync

The app tracks file states to avoid reprocessing unchanged files:

- **Modification time** - Skips files not modified since last sync
- **Content hash** - Skips files with identical content
- Files are automatically removed from the database when deleted

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

## Embedding Models

Docs4ai supports multiple embedding providers:

### Local Models (Free, Private, Offline-capable)

| Model | Dimensions | Size | Speed | Quality | Best For |
|-------|------------|------|-------|---------|----------|
| **Qwen3 Embedding** | 1024 | ~639MB | Medium | Best | Production use, highest quality *(Recommended)* |

**Advantages:**
- 100% private - data never leaves your machine
- No API costs
- Works offline after initial model download
- Consistent performance

**Disadvantages:**
- Lower quality than OpenAI (especially for complex queries)
- Requires disk space for models (~23MB to 1.1GB per model)
- First-time model download required

### OpenAI (Paid, Cloud-based)

| Model | Dimensions | Cost | Quality |
|-------|------------|------|---------|
| **text-embedding-3-large** | 3072 | $0.13/1M tokens | Highest |

**Advantages:**
- Best embedding quality
- No local storage needed
- Always up-to-date

**Disadvantages:**
- Requires API key and costs money
- Data sent to OpenAI
- Requires internet connection
- Rate limits apply

### Choosing an Embedding Provider

- **For most users**: Start with **Local Qwen3 Embedding** (free, good quality)
- **For maximum quality**: Use **OpenAI** (paid, best results)
- **For limited resources**: Use **OpenAI** if local storage is constrained

**Important**: Changing embedding providers requires clearing and re-syncing your database, as different models produce incompatible vector dimensions.

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

## License

MIT
