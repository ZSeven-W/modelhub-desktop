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

def pull_model(name, progress_callback=None):
    """Pull a model from Ollama library. Returns (success, proc)."""
    proc = subprocess.Popen(
        ['ollama', 'pull', name],
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
        item = download_queue.get()
        if item is None:
            break
        name, dl_id = item
        
        def on_progress(progress, status):
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

def delete_model(name):
    """Delete a model."""
    stdout, stderr, rc = run_ollama(['rm', name], timeout=30)
    return {'success': rc == 0, 'error': stderr if rc != 0 else None}

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
