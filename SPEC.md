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
- Filter by parameter size (7B, 13B, 70B, etc.)
- Filter by quantization (Q4, Q8, Q16, F16)
- Show model description and capabilities

### Model Download
- Pull models with real-time progress
- Download queue management
- Resume interrupted downloads
- Cancel active downloads

### Model Management
- List all installed Ollama models
- Display: name, tag, size, parameters, quantization, path
- Delete models (with confirmation)
- Refresh model list

### Model Organization
- Create/manage custom tags with colors
- Mark models as favorites
- Search/filter installed models by name/tag
- Sort by name, size, date installed

### Model Info
- View model metadata (full details from ollama show)
- Display modelfile content
- Show file location and size on disk
- Model capabilities and parameters

### Quick Launch
- One-click to open model in Terminal with ollama run
- Copy ollama run command to clipboard

### Storage Stats
- Per-model disk usage
- Total storage used by Ollama models
- Visual storage breakdown

### Model Comparison
- Side-by-side comparison of 2+ models
- Compare: parameters, size, quantization, capabilities

## REST API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Health check |
| GET | /api/models | List installed models |
| POST | /api/models/pull | Pull a model |
| GET | /api/models/search | Search Ollama library |
| DELETE | /api/models/:name | Delete a model |
| GET | /api/models/:name/info | Get model details |
| GET | /api/models/:name/modelfile | Get modelfile |
| POST | /api/models/:name/favorite | Toggle favorite |
| GET | /api/tags | List all tags |
| POST | /api/tags | Create a tag |
| DELETE | /api/tags/:id | Delete a tag |
| GET | /api/storage | Get storage statistics |
| POST | /api/models/compare | Compare models |
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
```

## Design
- **Dark theme**: #0d1117 bg, #161b22 panels, #30363d borders
- **Accent**: #3b82f6 (blue, "hub/model" vibe)
- **Cards**: model cards with size badge, favorite star, download progress
- **Views**: Grid view (default) / List view toggle
- **Typography**: System fonts + monospace for model info
- **Animations**: Smooth transitions, progress bar animations
