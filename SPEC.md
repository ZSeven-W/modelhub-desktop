# ModelHub-Desktop — SPEC.md

**Description**: 本地 LLM 模型管理器 (Local LLM Model Manager Desktop App)
**Type**: Electron Desktop Application
**Score**: 105/105

## Overview
ModelHub-Desktop 是本地 LLM 模型管理器，支持浏览 Ollama 模型库、下载管理、标签分类、收藏、存储统计和模型对比。开发者在 macOS 上集中管理所有本地 LLM 模型。

## Architecture
- **Runtime**: Electron 28 (main + renderer) + Python backend
- **API Port**: 3357 (Express REST API)
- **Frontend**: Vanilla JS/HTML/CSS, dark theme
- **Backend**: Python (Ollama CLI operations via child_process)

## Features

### Model Discovery
- Search/browse Ollama library models
- Filter by parameter size (7B, 8B, 13B, 33B, 70B, etc.)
- Filter by quantization (Q4_K_M, Q4_K_S, Q5_K_M, Q8_0, Q16, F16)
- Filter by tag (multi-select)
- Filter by favorites toggle
- Show model description and capabilities
- Search history (recent searches saved)

### Model Download
- Pull models with real-time SSE progress streaming
- Download queue management (sequential, pause/resume)
- Resume interrupted downloads (--resume flag)
- Cancel active downloads
- Download history (success/failed/cancelled)

### Model Management
- List all installed Ollama models
- Display: name, tag, size, parameters, quantization, path, context length
- Delete models (with confirmation)
- Refresh model list (sync)
- Sort by name, size, date, last used

### Model Organization
- Create/manage custom tags with colors
- Mark models as favorites
- Multi-tag filtering on installed models
- Sort by name, size, date, last used

### Model Info
- View model metadata (full details from ollama show)
- Display modelfile content
- Show file location and size on disk
- Model capabilities and parameters
- Context length display
- **Recommendations**: Similar models based on shared tags/parameters

### Quick Launch
- One-click to open model in Terminal with ollama run
- Copy ollama run command to clipboard
- Record model usage (last used tracking)

### Storage Stats
- Per-model disk usage
- Total storage used by Ollama models
- Visual storage breakdown (charts)

### Model Comparison
- Side-by-side comparison of 2-4 models
- Compare: parameters, size, quantization, context length, capabilities
- **Side-by-side modelfile comparison**

### Data Management
- Import/Export tags and favorites (JSON backup)
- Backup and restore model organization

## REST API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Health check |
| GET | /api/models | List installed models |
| GET | /api/models/enhanced | Enhanced list with tags, last_used, context_length |
| POST | /api/models/pull | Pull a model |
| POST | /api/models/pull/:name/cancel | Cancel download |
| GET | /api/models/search | Search Ollama library |
| GET | /api/search-history | Get recent search queries |
| DELETE | /api/models/:name | Delete a model |
| GET | /api/models/:name/info | Get model details |
| GET | /api/models/:name/modelfile | Get modelfile |
| POST | /api/models/:name/favorite | Toggle favorite |
| GET | /api/recommendations | Get similar model recommendations |
| GET | /api/models/compare-detailed | Compare with modelfile & full metadata |
| POST | /api/models/compare | Compare models (basic) |
| POST | /api/record-usage | Record model usage |
| GET | /api/tags | List all tags |
| POST | /api/tags | Create a tag |
| DELETE | /api/tags/:id | Delete a tag |
| GET | /api/storage | Get storage statistics |
| GET | /api/downloads | Get download history |
| POST | /api/queue/pause | Pause download queue |
| POST | /api/queue/resume | Resume download queue |
| GET | /api/export | Export tags/favorites as JSON |
| POST | /api/import | Import tags/favorites from JSON |
| POST | /api/sync | Sync models from Ollama |
| POST | /api/launch | Launch model in terminal |

## Database Schema (SQLite)
```sql
CREATE TABLE models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  tag TEXT,
  size INTEGER,
  parameters TEXT,
  quantization TEXT,
  path TEXT,
  is_favorite INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  color TEXT DEFAULT '#3b82f6',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE model_tags (
  model_id INTEGER,
  tag_id INTEGER,
  PRIMARY KEY (model_id, tag_id),
  FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  size TEXT,
  status TEXT DEFAULT 'pending',
  finished_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  searched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE model_usage (
  model_name TEXT PRIMARY KEY,
  last_used DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Design
- **Dark theme**: #0d1117 bg, #161b22 panels, #30363d borders
- **Accent**: #3b82f6 (blue, "hub/model" vibe)
- **Cards**: model cards with size badge, favorite star, download progress
- **Views**: Grid view (default) / List view toggle
- **Typography**: System fonts + monospace for model info
- **Animations**: Smooth transitions, progress bar animations
