# Docs4ai - Cross-Platform Folder Sync App

A native desktop application that watches a folder and automatically syncs it with a sqlite-vec database. Built with Electron, works on **macOS, Windows, and Linux**.

## Features

- **Real-time folder sync** - Monitors for file additions, modifications, and deletions
- **Incremental sync** - Only processes changed files based on modification time and content hash
- **sqlite-vec integration** - Proper vec0 virtual table for vector similarity search
- **OpenAI embeddings** - Uses text-embedding-3-large (3072 dimensions)
- **Cross-platform** - Runs natively on Mac, Windows, and Linux
- **Menu bar/system tray** - Status indicator with sync state
- **Multiple file formats** - Markdown, text, HTML, PDF, DOC, DOCX
- **Multi-language support** - UI available in 9 languages with instant switching
- **Multiple profiles** - Manage multiple independent sync configurations

## Supported File Types

| Extension | Library | Notes |
|-----------|---------|-------|
| `.md` | Built-in | Markdown files |
| `.txt` | Built-in | Plain text |
| `.html` / `.htm` | Built-in | HTML (tags stripped) |
| `.pdf` | pdf-parse | PDF text extraction |
| `.doc` | word-extractor | Legacy Word documents |
| `.docx` | mammoth | Modern Word documents |

## Requirements

- Node.js 18 or later
- npm

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
4. **Select Watch Folder** - Click "Select..." to choose a folder to monitor
5. **Select Database** - Choose where to save the sqlite-vec database
6. **Configure Settings**:
   - File extensions to watch
   - Recursive folder watching
   - OpenAI API key for embeddings
7. **Click "Start Syncing"** - The app syncs and monitors for changes

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

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/query` | POST | Query with `{ queryText, limit }` |
| `/mcp` | POST | MCP-compatible endpoint |

### Example Query

```bash
curl -X POST http://localhost:3333/query \
  -H "Content-Type: application/json" \
  -d '{"queryText": "How do I configure X?", "limit": 5}'
```

## Integration with External MCP Server

The database is also compatible with the doc2vec MCP server:

```bash
SQLITE_DB_DIR=/path/to/your/databases node mcp/dist/index.js
```

Database naming: Name your database file as needed (e.g., `my-docs.db`)

## Database Schema

Creates a proper `vec0` virtual table compatible with sqlite-vec:

```sql
CREATE VIRTUAL TABLE vec_items USING vec0(
    embedding FLOAT[3072],
    version TEXT,
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
- **OpenAI API** - Embedding generation
- **TypeScript** - Type-safe development

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

### PDF/DOC/DOCX not extracting
These are optional dependencies. Install them explicitly:
```bash
npm install pdf-parse word-extractor mammoth
```

## License

MIT
