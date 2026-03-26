#!/usr/bin/env python3
"""
ModelHub-Desktop Backend Server
REST API for local LLM model management via Ollama
"""

import json
import os
import sqlite3
import subprocess
import threading
import uuid
import queue as threadq
import time
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import re

# ─── Config ────────────────────────────────────────────────────────────────────
PORT = 3357
DATA_DIR = os.path.expanduser('~/.modelhub-desktop')
DB_PATH = os.path.join(DATA_DIR, 'modelhub.db')
os.makedirs(DATA_DIR, exist_ok=True)

# ─── Download Queue ────────────────────────────────────────────────────────────
download_queue = threadq.Queue()
pull_processes = {}  # name -> proc
pull_lock = threading.Lock()  # Thread-safe lock for active_pulls
MAX_CONCURRENT = 1  # Sequential downloads

# ─── Database ──────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    db = get_db()
    db.executescript('''
        CREATE TABLE IF NOT EXISTS models (
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
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            color TEXT DEFAULT '#3b82f6',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS model_tags (
            model_id INTEGER,
            tag_id INTEGER,
            PRIMARY KEY (model_id, tag_id),
            FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            size TEXT,
            status TEXT DEFAULT 'pending',
            finished_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS search_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query TEXT NOT NULL,
            searched_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS model_usage (
            model_name TEXT PRIMARY KEY,
            last_used DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    ''')
    db.commit()
    db.close()

# ─── Ollama Helpers ────────────────────────────────────────────────────────────
def run_ollama(args, timeout=30):
    """Run ollama CLI and return stdout."""
    try:
        result = subprocess.run(
            ['ollama'] + args,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return result.stdout.strip(), result.stderr.strip(), result.returncode
    except subprocess.TimeoutExpired:
        return '', 'Timeout', 1
    except FileNotFoundError:
        return '', 'Ollama not found. Please install from https://ollama.com', 1

def list_installed_models():
    """Get list of installed models from ollama."""
    stdout, _, rc = run_ollama(['list'])
    if rc != 0:
        return []
    
    models = []
    lines = stdout.strip().split('\n')
    if len(lines) < 2:
        return models
    
    for line in lines[1:]:  # Skip header
        parts = line.split()
        if len(parts) >= 3:
            name = parts[0]
            size = parts[1]
            updated = parts[2] if len(parts) > 2 else ''
            
            # Parse parameters from name (e.g., "llama3:8b-instruct-q4_K_M")
            params = ''
            quant = ''
            tag = ''
            
            # Common patterns
            if ':' in name:
                parts_name = name.split(':')
                tag = parts_name[1] if len(parts_name) > 1 else ''
                
                # Extract param size
                param_match = re.search(r'(\d+b)', parts_name[0])
                if param_match:
                    params = param_match.group(1)
                
                # Extract quantization
                for q in ['q4_K_M', 'q4_K_S', 'q5_K_M', 'q5_K_S', 'q8_0', 'q2_K', 'q3_K_M', 'q3_K_S', 'q16', 'f16', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'q6_K']:
                    if q in tag:
                        quant = q
                        break
            
            # Get model path
            ollama_dir = os.path.expanduser('~/.ollama/models')
            model_path = os.path.join(ollama_dir, 'manifests', 'registry.ollama.ai', 'library', name.replace(':', '/'))
            
            models.append({
                'name': name,
                'tag': tag,
                'size': size,
                'parameters': params,
                'quantization': quant,
                'path': model_path,
                'updated': updated,
            })
    
    return models

def get_model_info(name):
    """Get detailed model info from ollama show."""
    stdout, stderr, rc = run_ollama(['show', name], timeout=15)
    if rc != 0:
        return {'error': stderr or stdout}
    
    info = {'name': name, 'raw': stdout}
    
    # Parse key fields
    for line in stdout.split('\n'):
        if ':' in line:
            key, val = line.split(':', 1)
            info[key.strip().lower().replace(' ', '_')] = val.strip()
    
    return info

def get_modelfile(name):
    """Get modelfile for a model."""
    stdout, stderr, rc = run_ollama(['show', name, '--modelfile'], timeout=15)
    if rc != 0:
        return {'error': stderr or stdout}
    return {'modelfile': stdout}

def search_ollama_library(query=''):
    """Search Ollama library."""
    stdout, stderr, rc = run_ollama(['search', query], timeout=30)
    if rc != 0:
        return []
    
    models = []
    current = {}
    for line in stdout.strip().split('\n'):
        line = line.strip()
        if not line:
            if current.get('name'):
                models.append(current)
            current = {}
            continue
        
        if line.startswith('NAME:'):
            current['name'] = line[5:].strip()
        elif line.startswith('DESCRIPTION:'):
            current['description'] = line[12:].strip()
        elif line.startswith('SIZE:'):
            current['size'] = line[5:].strip()
        elif line.startswith('MODIFIED:'):
            current['modified'] = line[9:].strip()
    
    if current.get('name'):
        models.append(current)
    
    return models

def pull_model(name, progress_callback=None, resume=False):
    """Pull a model from Ollama library. Returns (success, proc)."""
    cmd = ['ollama', 'pull', name]
    if resume:
        cmd.append('--resume')
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )
    
    with pull_lock:
        pull_processes[name] = proc
    
    progress = 0
    for line in proc.stdout:
        line = line.strip()
        
        # Parse progress from lines like "pulling manifest... 100% | ████████ | 1.2GB/1.2GB""
        if '%' in line:
            match = re.search(r'(\d+)%', line)
            if match:
                progress = int(match.group(1))
        
        if progress_callback:
            progress_callback(progress, line)
    
    proc.wait()
    with pull_lock:
        if name in pull_processes:
            del pull_processes[name]
    
    return proc.returncode == 0


# ─── Download Queue Worker ─────────────────────────────────────────────────────
def process_download_queue():
    """Worker thread: processes the download queue one at a time."""
    while True:
        try:
            # Check pause flag
            if getattr(download_queue, 'pause_flag', False):
                time.sleep(1)
                continue

            try:
                item = download_queue.get(timeout=2)
            except threadq.Empty:
                continue

            if item is None:
                break
            name, dl_id = item

            # Check pause before starting
            if getattr(download_queue, 'pause_flag', False):
                with pull_lock:
                    active_pulls[name] = {
                        'progress': active_pulls.get(name, {}).get('progress', 0),
                        'status': 'queued',
                        'done': False,
                        'dl_id': dl_id,
                    }
                download_queue.task_done()
                continue

            def on_progress(progress, status):
                # Check pause during download
                if getattr(download_queue, 'pause_flag', False):
                    with pull_lock:
                        if name in pull_processes:
                            proc = pull_processes.get(name)
                            if proc:
                                proc.terminate()
                    return
                with pull_lock:
                    active_pulls[name] = {
                        'progress': progress,
                        'status': status,
                        'done': False,
                        'dl_id': dl_id,
                    }

            success = pull_model(name, on_progress)
            status = 'done' if success else 'failed'

            with pull_lock:
                active_pulls[name] = {
                    'progress': 100 if success else active_pulls.get(name, {}).get('progress', 0),
                    'status': status,
                    'done': True,
                    'dl_id': dl_id,
                }

            # Update download history
            db = get_db()
            db.execute(
                'UPDATE downloads SET status=?, finished_at=CURRENT_TIMESTAMP WHERE id=?',
                (status, dl_id)
            )
            db.commit()
            db.close()

            if success:
                sync_models_to_db()

            download_queue.task_done()
        except Exception:
            pass

def delete_model(name):
    """Delete a model."""
    stdout, stderr, rc = run_ollama(['rm', name], timeout=30)
    return {'success': rc == 0, 'error': stderr if rc != 0 else None}

def get_model_context_length(name):
    """Get context length from ollama show."""
    info = get_model_info(name)
    # Try to parse context length
    for key in ['contextlength', 'context_length', 'num_ctx']:
        if key in info:
            try:
                return int(info[key])
            except (ValueError, TypeError):
                pass
    return None

def get_recommendations(model_name, limit=5):
    """Get model recommendations based on similar models."""
    db = get_db()
    model_row = db.execute('SELECT * FROM models WHERE name=?', (model_name,)).fetchone()
    if not model_row:
        db.close()
        return []

    # Get tags for this model
    tag_rows = db.execute('''
        SELECT tag_id FROM model_tags WHERE model_id=?''', (model_row['id'],)).fetchall()
    tag_ids = [r['tag_id'] for r in tag_rows]

    if not tag_ids:
        # Fall back to parameter-based recommendations
        params = model_row['parameters']
        quant = model_row['quantization']
        similar = db.execute('''
            SELECT m.*, COUNT(mt.tag_id) as tag_match
            FROM models m
            LEFT JOIN model_tags mt ON m.id = mt.model_id AND mt.tag_id IN ({seq})
            WHERE m.name != ?
            GROUP BY m.id
            ORDER BY tag_match DESC, m.parameters=?, m.quantization=?
            LIMIT ?
        '''.format(seq=','.join(['?']*len(tag_ids)) if tag_ids else 'NULL'),
            ([r['tag_id'] for r in tag_rows] if tag_ids else []) + [model_name, params, quant, limit]
        ).fetchall()
    else:
        similar = db.execute('''
            SELECT m.*, COUNT(mt.tag_id) as tag_match
            FROM models m
            JOIN model_tags mt ON m.id = mt.model_id AND mt.tag_id IN ({seq})
            WHERE m.name != ?
            GROUP BY m.id
            ORDER BY tag_match DESC
            LIMIT ?
        '''.format(seq=','.join(['?']*len(tag_ids))),
            [r['tag_id'] for r in tag_rows] + [model_name, limit]
        ).fetchall()

    db.close()
    return [dict(r) for r in similar]

def export_data():
    """Export all tags, favorites, and model-tag associations."""
    db = get_db()
    tags = [dict(r) for r in db.execute('SELECT * FROM tags')]
    models = [dict(r) for r in db.execute('SELECT name, is_favorite FROM models')]
    model_tags = [dict(r) for r in db.execute('''
        SELECT mt.model_id, mt.tag_id, m.name as model_name, t.name as tag_name
        FROM model_tags mt
        JOIN models m ON mt.model_id = m.id
        JOIN tags t ON mt.tag_id = t.id
    ''')]
    db.close()
    return {'tags': tags, 'models': models, 'model_tags': model_tags}

def import_data(data):
    """Import tags, favorites, and model-tag associations."""
    db = get_db()
    imported_tags = []
    # Import tags
    for tag in data.get('tags', []):
        try:
            db.execute('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)',
                       (tag['name'], tag.get('color', '#3b82f6')))
            imported_tags.append(tag['name'])
        except Exception:
            pass

    db.commit()

    # Import favorites
    for model in data.get('models', []):
        if model.get('is_favorite'):
            db.execute('UPDATE models SET is_favorite=1 WHERE name=?', (model['name'],))

    db.commit()

    # Import model-tag associations
    for mt in data.get('model_tags', []):
        model_row = db.execute('SELECT id FROM models WHERE name=?', (mt['model_name'],)).fetchone()
        tag_row = db.execute('SELECT id FROM tags WHERE name=?', (mt['tag_name'],)).fetchone()
        if model_row and tag_row:
            try:
                db.execute('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)',
                           (model_row['id'], tag_row['id']))
            except Exception:
                pass

    db.commit()
    db.close()
    return {'imported_tags': len(imported_tags)}

def record_usage(model_name):
    """Record model usage (for sort by last used)."""
    db = get_db()
    db.execute('''INSERT INTO model_usage (model_name, last_used)
                  VALUES (?, CURRENT_TIMESTAMP)
                  ON CONFLICT(model_name) DO UPDATE SET last_used=CURRENT_TIMESTAMP''',
               (model_name,))
    db.commit()
    db.close()

def get_storage_stats():
    """Get storage statistics for Ollama models."""
    ollama_dir = os.path.expanduser('~/.ollama/models')
    total_size = 0
    models_info = []
    
    manifests_dir = os.path.join(ollama_dir, 'manifests', 'registry.ollama.ai', 'library')
    
    if os.path.exists(manifests_dir):
        for model in os.listdir(manifests_dir):
            model_path = os.path.join(manifests_dir, model)
            tag_path = os.path.join(model_path, os.listdir(model_path)[0] if os.listdir(model_path) else '')
            
            if os.path.exists(tag_path):
                size = sum(
                    os.path.getsize(os.path.join(dirpath, f))
                    for dirpath, _, filenames in os.walk(tag_path)
                    for f in filenames
                )
                total_size += size
                models_info.append({
                    'name': model.replace('/', ':'),
                    'path': tag_path,
                    'size': size,
                    'size_formatted': format_bytes(size),
                })
    
    # Also check blobs
    blobs_dir = os.path.join(ollama_dir, 'blobs')
    if os.path.exists(blobs_dir):
        for f in os.listdir(blobs_dir):
            fpath = os.path.join(blobs_dir, f)
            if os.path.isfile(fpath):
                total_size += os.path.getsize(fpath)
    
    return {
        'total': total_size,
        'total_formatted': format_bytes(total_size),
        'models': models_info,
    }

def format_bytes(size):
    """Format bytes to human-readable string."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024:
            return f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}PB"

# ─── Sync models to DB ────────────────────────────────────────────────────────
def sync_models_to_db():
    """Sync installed Ollama models to local SQLite DB."""
    db = get_db()
    installed = list_installed_models()
    existing = {row['name'] for row in db.execute('SELECT name FROM models')}
    
    for model in installed:
        if model['name'] in existing:
            db.execute(
                'UPDATE models SET tag=?, size=?, parameters=?, quantization=?, path=? WHERE name=?',
                (model['tag'], model['size'], model['parameters'], model['quantization'], model['path'], model['name'])
            )
        else:
            db.execute(
                'INSERT INTO models (name, tag, size, parameters, quantization, path) VALUES (?, ?, ?, ?, ?, ?)',
                (model['name'], model['tag'], model['size'], model['parameters'], model['quantization'], model['path'])
            )
    
    # Remove models no longer installed
    installed_names = [m['name'] for m in installed]
    for name in existing:
        if name not in installed_names:
            db.execute('DELETE FROM models WHERE name=?', (name,))
    
    db.commit()
    db.close()

# ─── HTTP Server ───────────────────────────────────────────────────────────────
active_pulls = {}  # name -> {'progress': int, 'status': str, 'done': bool}

# Start queue worker
queue_worker = threading.Thread(target=process_download_queue, daemon=True)
queue_worker.start()

class Handler(BaseHTTPRequestHandler):
    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _send_sse_event(self, event_name, data):
        """Send a Server-Sent Events message."""
        self.wfile.write(f"event: {event_name}\n".encode())
        self.wfile.write(f"data: {json.dumps(data)}\n\n".encode())

    def _parse_body(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length:
            return json.loads(self.rfile.read(content_length))
        return {}

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        try:
            if path == '/api/health':
                self._send_json({'success': True, 'status': 'ok', 'time': datetime.now().isoformat()})

            elif path == '/api/models':
                db = get_db()
                models = [dict(r) for r in db.execute('SELECT * FROM models ORDER BY name')]
                db.close()
                self._send_json({'success': True, 'data': models})

            elif path.startswith('/api/models/') and path.endswith('/info'):
                name = path.replace('/api/models/', '').replace('/info', '')
                info = get_model_info(name)
                self._send_json({'success': True, 'data': info})

            elif path.startswith('/api/models/') and path.endswith('/modelfile'):
                name = path.replace('/api/models/', '').replace('/modelfile', '')
                mf = get_modelfile(name)
                self._send_json({'success': True, 'data': mf})

            # Model tags
            elif path.startswith('/api/models/') and '/tags' in path and path != '/api/models/tags':
                parts = path.replace('/api/models/', '').split('/tags')
                name = parts[0]
                db = get_db()
                model_row = db.execute('SELECT id FROM models WHERE name=?', (name,)).fetchone()
                if model_row:
                    tags = [dict(r) for r in db.execute('''
                        SELECT t.* FROM tags t
                        JOIN model_tags mt ON t.id = mt.tag_id
                        WHERE mt.model_id=?
                    ''', (model_row['id'],))]
                    db.close()
                    self._send_json({'success': True, 'data': tags})
                else:
                    db.close()
                    self._send_json({'success': False, 'error': 'Model not found'}, 404)

            elif path == '/api/models/search':
                q = query.get('q', [''])[0]
                results = search_ollama_library(q)
                # Record search history
                if q:
                    db = get_db()
                    db.execute('INSERT INTO search_history (query) VALUES (?)', (q,))
                    db.commit()
                    db.close()
                self._send_json({'success': True, 'data': results})

            elif path == '/api/tags':
                db = get_db()
                tags = [dict(r) for r in db.execute('SELECT * FROM tags ORDER BY name')]
                db.close()
                self._send_json({'success': True, 'data': tags})

            elif path == '/api/storage':
                stats = get_storage_stats()
                self._send_json({'success': True, 'data': stats})

            elif path == '/api/downloads':
                db = get_db()
                downloads = [dict(r) for r in db.execute('SELECT * FROM downloads ORDER BY created_at DESC LIMIT 50')]
                db.close()
                self._send_json({'success': True, 'data': downloads})

            elif path == '/api/search-history':
                db = get_db()
                history = [dict(r) for r in db.execute(
                    'SELECT DISTINCT query, MAX(searched_at) as searched_at FROM search_history GROUP BY query ORDER BY searched_at DESC LIMIT 20'
                )]
                db.close()
                self._send_json({'success': True, 'data': history})

            elif path == '/api/recommendations':
                name = query.get('name', [''])[0]
                recs = get_recommendations(name) if name else []
                self._send_json({'success': True, 'data': recs})

            elif path == '/api/export':
                data = export_data()
                self._send_json({'success': True, 'data': data})

            elif path == '/api/models/compare-detailed':
                names = query.get('names', [])
                results = []
                for name in names:
                    info = get_model_info(name)
                    mf = get_modelfile(name)
                    ctx_len = get_model_context_length(name)
                    db = get_db()
                    row = db.execute('SELECT * FROM models WHERE name=?', (name,)).fetchone()
                    usage = db.execute('SELECT last_used FROM model_usage WHERE model_name=?', (name,)).fetchone()
                    db.close()
                    results.append({
                        **info,
                        'modelfile': mf.get('modelfile', ''),
                        'context_length': ctx_len,
                        'db': dict(row) if row else {},
                        'last_used': usage['last_used'] if usage else None,
                    })
                self._send_json({'success': True, 'data': results})

            # SSE stream for all active pulls
            elif path == '/api/pulls/stream':
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Connection', 'keep-alive')
                self.end_headers()

                # Send current state immediately
                with pull_lock:
                    for name, pull_data in active_pulls.items():
                        self._send_sse_event('progress', {'name': name, **pull_data})

                # Stream updates
                last_state = {}
                while True:
                    try:
                        time.sleep(0.5)
                        with pull_lock:
                            current_state = dict(active_pulls)
                        for name, data in current_state.items():
                            key = (name, data.get('progress'), data.get('status'), data.get('done'))
                            if key != last_state.get(name):
                                self._send_sse_event('progress', {'name': name, **data})
                                last_state[name] = key
                    except (BrokenPipeError, ConnectionResetError):
                        break
                return

            elif path.startswith('/api/pulls/'):
                name = path.replace('/api/pulls/', '')
                with pull_lock:
                    pull = active_pulls.get(name, {'progress': 0, 'status': 'idle', 'done': True})
                self._send_json({'success': True, 'data': pull})

            else:
                self._send_json({'success': False, 'error': 'Not found'}, 404)

        except Exception as e:
            import traceback
            traceback.print_exc()
            self._send_json({'success': False, 'error': str(e)}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._parse_body()

        try:
            if path == '/api/models/pull':
                name = body.get('name')
                if not name:
                    self._send_json({'success': False, 'error': 'Model name required'}, 400)
                    return

                with pull_lock:
                    is_running = name in active_pulls and not active_pulls[name].get('done')
                    in_queue_names = [n for n in download_queue.queue if n[0] == name]
                    is_queued = bool(in_queue_names)

                if is_running:
                    self._send_json({'success': True, 'data': {'status': 'already_running', 'name': name}})
                    return
                if is_queued:
                    self._send_json({'success': True, 'data': {'status': 'already_queued', 'name': name}})
                    return

                # Record in download history
                db = get_db()
                cursor = db.execute('INSERT INTO downloads (name, status) VALUES (?, ?)', (name, 'queued'))
                dl_id = cursor.lastrowid
                db.commit()
                db.close()

                with pull_lock:
                    active_pulls[name] = {'progress': 0, 'status': 'queued', 'done': False, 'dl_id': dl_id}

                download_queue.put((name, dl_id))

                self._send_json({'success': True, 'data': {'status': 'queued', 'name': name, 'dl_id': dl_id}})

            # Cancel download
            elif path.startswith('/api/models/pull/') and path.endswith('/cancel'):
                name = path.replace('/api/models/pull/', '').replace('/cancel', '')
                cancelled = False
                with pull_lock:
                    if name in pull_processes:
                        proc = pull_processes[name]
                        proc.terminate()
                        try:
                            proc.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                        del pull_processes[name]
                        cancelled = True

                if cancelled:
                    with pull_lock:
                        active_pulls[name] = {
                            'progress': active_pulls.get(name, {}).get('progress', 0),
                            'status': 'cancelled',
                            'done': True,
                            'dl_id': active_pulls.get(name, {}).get('dl_id'),
                        }
                    # Update history
                    db = get_db()
                    dl_id = active_pulls.get(name, {}).get('dl_id')
                    if dl_id:
                        db.execute('UPDATE downloads SET status=? WHERE id=?', ('cancelled', dl_id))
                        db.commit()
                    db.close()
                    self._send_json({'success': True, 'data': {'status': 'cancelled', 'name': name}})
                else:
                    self._send_json({'success': False, 'error': 'No active download found'}, 404)

            elif path.startswith('/api/models/') and path.endswith('/favorite'):
                name = path.replace('/api/models/', '').replace('/favorite', '')
                db = get_db()
                row = db.execute('SELECT is_favorite FROM models WHERE name=?', (name,)).fetchone()
                if row:
                    new_val = 0 if row['is_favorite'] else 1
                    db.execute('UPDATE models SET is_favorite=? WHERE name=?', (new_val, name))
                    db.commit()
                    db.close()
                    self._send_json({'success': True, 'data': {'is_favorite': new_val}})
                else:
                    db.close()
                    self._send_json({'success': False, 'error': 'Model not found'}, 404)

            # Assign tag to model
            elif path.startswith('/api/models/') and '/tags/' in path:
                parts = path.replace('/api/models/', '').split('/tags/')
                name = parts[0]
                tag_id = int(parts[1])
                db = get_db()
                model_row = db.execute('SELECT id FROM models WHERE name=?', (name,)).fetchone()
                if not model_row:
                    db.close()
                    self._send_json({'success': False, 'error': 'Model not found'}, 404)
                    return
                try:
                    db.execute('INSERT INTO model_tags (model_id, tag_id) VALUES (?, ?)',
                               (model_row['id'], tag_id))
                    db.commit()
                    db.close()
                    self._send_json({'success': True, 'data': {'message': 'Tag assigned'}})
                except sqlite3.IntegrityError:
                    db.close()
                    self._send_json({'success': False, 'error': 'Tag already assigned'}, 400)

            elif path == '/api/tags':
                name = body.get('name')
                color = body.get('color', '#3b82f6')
                if not name:
                    self._send_json({'success': False, 'error': 'Tag name required'}, 400)
                    return

                db = get_db()
                try:
                    cursor = db.execute('INSERT INTO tags (name, color) VALUES (?, ?)', (name, color))
                    db.commit()
                    tag_id = cursor.lastrowid
                    db.close()
                    self._send_json({'success': True, 'data': {'id': tag_id, 'name': name, 'color': color}})
                except sqlite3.IntegrityError:
                    db.close()
                    self._send_json({'success': False, 'error': 'Tag already exists'}, 400)

            elif path == '/api/models/compare':
                names = body.get('names', [])
                results = []
                for name in names:
                    info = get_model_info(name)
                    db = get_db()
                    row = db.execute('SELECT * FROM models WHERE name=?', (name,)).fetchone()
                    db.close()
                    results.append({**info, 'db': dict(row) if row else {}})
                self._send_json({'success': True, 'data': results})

            elif path == '/api/sync':
                sync_models_to_db()
                self._send_json({'success': True, 'data': {'message': 'Synced'}})

            elif path == '/api/import':
                result = import_data(body)
                self._send_json({'success': True, 'data': result})

            elif path == '/api/record-usage':
                name = body.get('name')
                if name:
                    record_usage(name)
                self._send_json({'success': True})

            elif path == '/api/queue/pause':
                download_queue.pause_flag = getattr(download_queue, 'pause_flag', False)
                download_queue.pause_flag = True
                with pull_lock:
                    for name, data in active_pulls.items():
                        if not data.get('done'):
                            data['status'] = 'paused'
                self._send_json({'success': True, 'data': {'status': 'paused'}})

            elif path == '/api/queue/resume':
                download_queue.pause_flag = False
                with pull_lock:
                    for name, data in active_pulls.items():
                        if data.get('status') == 'paused':
                            data['status'] = 'downloading'
                self._send_json({'success': True, 'data': {'status': 'resumed'}})

            elif path == '/api/models/enhanced':
                # Enhanced models list with filtering, sorting, context length
                db = get_db()
                tag_filter = query.get('tag', [])
                favorite_filter = query.get('favorites', [''])[0] == 'true'
                sort_by = query.get('sort', ['name'])[0]
                sort_order = query.get('order', ['asc'])[0]
                date_from = query.get('date_from', [''])[0]
                date_to = query.get('date_to', [''])[0]

                sql = '''
                    SELECT m.*, u.last_used,
                    (SELECT GROUP_CONCAT(t.name) FROM model_tags mt JOIN tags t ON mt.tag_id = t.id WHERE mt.model_id = m.id) as tag_names
                    FROM models m
                    LEFT JOIN model_usage u ON m.name = u.model_name
                    WHERE 1=1
                '''
                params = []

                if favorite_filter:
                    sql += ' AND m.is_favorite = 1'
                if date_from:
                    sql += ' AND m.created_at >= ?'
                    params.append(date_from)
                if date_to:
                    sql += ' AND m.created_at <= ?'
                    params.append(date_to)
                if tag_filter:
                    placeholders = ','.join(['?'] * len(tag_filter))
                    sql += f''' AND m.id IN (
                        SELECT model_id FROM model_tags WHERE tag_id IN (
                            SELECT id FROM tags WHERE name IN ({placeholders})
                        )
                    )'''
                    params.extend(tag_filter)

                # Sort
                sort_map = {
                    'name': 'm.name', 'size': 'm.size', 'date': 'm.created_at',
                    'last_used': 'u.last_used', 'context': 'm.parameters'
                }
                sort_col = sort_map.get(sort_by, 'm.name')
                sort_dir = 'DESC' if sort_order == 'desc' else 'ASC'
                sql += f' ORDER BY {sort_col} {sort_dir}'

                rows = [dict(r) for r in db.execute(sql, params).fetchall()]

                # Add context length from ollama info
                for row in rows:
                    ctx = get_model_context_length(row['name'])
                    row['context_length'] = ctx

                db.close()
                self._send_json({'success': True, 'data': rows})

            else:
                self._send_json({'success': False, 'error': 'Not found'}, 404)

        except Exception as e:
            import traceback
            traceback.print_exc()
            self._send_json({'success': False, 'error': str(e)}, 500)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        try:
            if path.startswith('/api/models/') and '/tags/' in path:
                parts = path.replace('/api/models/', '').split('/tags/')
                name = parts[0]
                tag_id = int(parts[1])
                db = get_db()
                model_row = db.execute('SELECT id FROM models WHERE name=?', (name,)).fetchone()
                if model_row:
                    db.execute('DELETE FROM model_tags WHERE model_id=? AND tag_id=?',
                               (model_row['id'], tag_id))
                    db.commit()
                db.close()
                self._send_json({'success': True})

            elif path.startswith('/api/models/'):
                name = path.replace('/api/models/', '')
                result = delete_model(name)
                if result['success']:
                    db = get_db()
                    db.execute('DELETE FROM models WHERE name=?', (name,))
                    db.commit()
                    db.close()
                self._send_json(result)

            elif path.startswith('/api/tags/'):
                tag_id = path.replace('/api/tags/', '')
                db = get_db()
                db.execute('DELETE FROM tags WHERE id=?', (tag_id,))
                db.commit()
                db.close()
                self._send_json({'success': True})

            else:
                self._send_json({'success': False, 'error': 'Not found'}, 404)

        except Exception as e:
            self._send_json({'success': False, 'error': str(e)}, 500)

    def log_message(self, fmt, *args):
        pass  # Suppress default logging

# ─── Main ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    sync_models_to_db()
    
    server = HTTPServer(('localhost', PORT), Handler)
    print(f'ModelHub Backend running on http://localhost:{PORT}')
    print(f'Database: {DB_PATH}')
    server.serve_forever()
