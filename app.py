"""
Real-Time Face Emotion Recognition - Flask Backend
Handles: Auth, Prediction via DeepFace, Emotion history, Analytics
"""

import os
import base64
import io
import json
import logging
from datetime import datetime, timedelta
from functools import wraps

import cv2
import numpy as np
from flask import Flask, request, jsonify, g
from flask_cors import CORS
from PIL import Image
import sqlite3
import hashlib
import secrets
import time

# DeepFace for emotion recognition
try:
    from deepface import DeepFace
    DEEPFACE_AVAILABLE = True
except ImportError:
    DEEPFACE_AVAILABLE = False
    logging.warning("DeepFace not available, using fallback model")

# Fallback: OpenCV Haar cascade + simple CNN via fer library
try:
    from fer import FER
    FER_AVAILABLE = True
except ImportError:
    FER_AVAILABLE = False

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = secrets.token_hex(32)
CORS(app, resources={r"/api/*": {"origins": "*"}})

# ─── DATABASE ────────────────────────────────────────────────────────────────

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'database', 'emotions.db')

def get_db():
    if 'db' not in g:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(error):
    db = g.pop('db', None)
    if db is not None:
        db.close()

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS emotion_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            emotion TEXT NOT NULL,
            confidence REAL NOT NULL,
            all_emotions TEXT,
            face_detected INTEGER DEFAULT 1,
            recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    ''')
    conn.commit()
    conn.close()
    logger.info("Database initialized at %s", DB_PATH)

# ─── AUTH HELPERS ─────────────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    hashed = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}:{hashed}"

def verify_password(password: str, stored: str) -> bool:
    try:
        salt, hashed = stored.split(':')
        return hashlib.sha256((salt + password).encode()).hexdigest() == hashed
    except Exception:
        return False

def create_session(user_id: int) -> str:
    token = secrets.token_hex(32)
    expires = datetime.now() + timedelta(days=7)
    db = get_db()
    db.execute(
        "INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)",
        (user_id, token, expires.isoformat())
    )
    db.commit()
    return token

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if not token:
            return jsonify({'error': 'No token provided'}), 401
        db = get_db()
        row = db.execute(
            "SELECT s.user_id, s.expires_at, u.username FROM sessions s "
            "JOIN users u ON u.id = s.user_id WHERE s.token = ?", (token,)
        ).fetchone()
        if not row:
            return jsonify({'error': 'Invalid token'}), 401
        if datetime.fromisoformat(row['expires_at']) < datetime.now():
            db.execute("DELETE FROM sessions WHERE token = ?", (token,))
            db.commit()
            return jsonify({'error': 'Token expired'}), 401
        g.user_id = row['user_id']
        g.username = row['username']
        return f(*args, **kwargs)
    return decorated

# ─── ML MODEL ────────────────────────────────────────────────────────────────

class EmotionDetector:
    """Unified emotion detector with multiple backends."""

    EMOTION_EMOJI = {
        'happy': '😄', 'sad': '😢', 'angry': '😠',
        'fear': '😨', 'surprise': '😲', 'disgust': '🤢',
        'neutral': '😐'
    }

    def __init__(self):
        self.backend = None
        self.fer_detector = None
        self._initialize()

    def _initialize(self):
        if DEEPFACE_AVAILABLE:
            self.backend = 'deepface'
            logger.info("Using DeepFace backend")
        elif FER_AVAILABLE:
            self.fer_detector = FER(mtcnn=False)
            self.backend = 'fer'
            logger.info("Using FER backend")
        else:
            self.backend = 'opencv'
            logger.info("Using OpenCV fallback backend")

    def decode_image(self, data_uri: str) -> np.ndarray:
        """Decode base64 image data URI to numpy array."""
        if ',' in data_uri:
            data_uri = data_uri.split(',')[1]
        img_bytes = base64.b64decode(data_uri)
        img = Image.open(io.BytesIO(img_bytes)).convert('RGB')
        return np.array(img)

    def predict(self, image_data: str) -> dict:
        """Run emotion prediction and return structured result."""
        try:
            img_array = self.decode_image(image_data)

            if self.backend == 'deepface':
                return self._predict_deepface(img_array)
            elif self.backend == 'fer':
                return self._predict_fer(img_array)
            else:
                return self._predict_opencv(img_array)

        except Exception as e:
            logger.error("Prediction error: %s", e)
            return {
                'face_detected': False,
                'emotion': None,
                'confidence': 0.0,
                'all_emotions': {},
                'emoji': '',
                'error': str(e)
            }

    def _predict_deepface(self, img: np.ndarray) -> dict:
        img_bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        results = DeepFace.analyze(
            img_bgr,
            actions=['emotion'],
            enforce_detection=False,
            silent=True
        )
        if isinstance(results, list):
            results = results[0]

        dominant = results['dominant_emotion']
        emotions = results['emotion']
        confidence = emotions.get(dominant, 0.0) / 100.0

        return {
            'face_detected': True,
            'emotion': dominant,
            'confidence': round(confidence, 4),
            'all_emotions': {k: round(v / 100.0, 4) for k, v in emotions.items()},
            'emoji': self.EMOTION_EMOJI.get(dominant, '🤔'),
            'faces_count': 1
        }

    def _predict_fer(self, img: np.ndarray) -> dict:
        result = self.fer_detector.detect_emotions(img)
        if not result:
            return {'face_detected': False, 'emotion': None, 'confidence': 0.0,
                    'all_emotions': {}, 'emoji': ''}

        face = result[0]
        emotions = face['emotions']
        dominant = max(emotions, key=emotions.get)
        confidence = emotions[dominant]

        return {
            'face_detected': True,
            'emotion': dominant,
            'confidence': round(confidence, 4),
            'all_emotions': {k: round(v, 4) for k, v in emotions.items()},
            'emoji': self.EMOTION_EMOJI.get(dominant, '🤔'),
            'faces_count': len(result)
        }

    def _predict_opencv(self, img: np.ndarray) -> dict:
        """Fallback: basic face detection only, mock emotion."""
        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        face_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        )
        faces = face_cascade.detectMultiScale(gray, 1.1, 4)
        if len(faces) == 0:
            return {'face_detected': False, 'emotion': None, 'confidence': 0.0,
                    'all_emotions': {}, 'emoji': ''}

        # Without a real model, return neutral as placeholder
        return {
            'face_detected': True,
            'emotion': 'neutral',
            'confidence': 0.75,
            'all_emotions': {'neutral': 0.75, 'happy': 0.10, 'sad': 0.05,
                             'angry': 0.05, 'surprise': 0.05},
            'emoji': '😐',
            'faces_count': len(faces),
            'note': 'Install deepface or fer for real emotion detection'
        }


detector = EmotionDetector()

# ─── AUTH ROUTES ─────────────────────────────────────────────────────────────

@app.route('/api/auth/signup', methods=['POST'])
def signup():
    data = request.get_json()
    username = (data.get('username') or '').strip()
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''

    if not username or not email or not password:
        return jsonify({'error': 'All fields required'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400

    db = get_db()
    existing = db.execute(
        "SELECT id FROM users WHERE username = ? OR email = ?", (username, email)
    ).fetchone()
    if existing:
        return jsonify({'error': 'Username or email already exists'}), 409

    pw_hash = hash_password(password)
    cur = db.execute(
        "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
        (username, email, pw_hash)
    )
    db.commit()
    token = create_session(cur.lastrowid)
    return jsonify({'token': token, 'username': username}), 201


@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.get_json()
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''

    db = get_db()
    user = db.execute(
        "SELECT id, username, password_hash FROM users WHERE username = ? OR email = ?",
        (username, username)
    ).fetchone()

    if not user or not verify_password(password, user['password_hash']):
        return jsonify({'error': 'Invalid credentials'}), 401

    token = create_session(user['id'])
    return jsonify({'token': token, 'username': user['username']})


@app.route('/api/auth/logout', methods=['POST'])
@require_auth
def logout():
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    db = get_db()
    db.execute("DELETE FROM sessions WHERE token = ?", (token,))
    db.commit()
    return jsonify({'message': 'Logged out'})


@app.route('/api/auth/me', methods=['GET'])
@require_auth
def me():
    return jsonify({'user_id': g.user_id, 'username': g.username})

# ─── PREDICTION ROUTE ────────────────────────────────────────────────────────

@app.route('/api/predict', methods=['POST'])
@require_auth
def predict():
    start = time.time()
    data = request.get_json()
    image_data = data.get('image')

    if not image_data:
        return jsonify({'error': 'No image data'}), 400

    result = detector.predict(image_data)
    result['processing_ms'] = round((time.time() - start) * 1000, 1)

    # Persist to DB if face detected
    if result.get('face_detected') and result.get('emotion'):
        db = get_db()
        db.execute(
            "INSERT INTO emotion_records (user_id, emotion, confidence, all_emotions) "
            "VALUES (?, ?, ?, ?)",
            (g.user_id, result['emotion'], result['confidence'],
             json.dumps(result.get('all_emotions', {})))
        )
        db.commit()

    return jsonify(result)

# ─── HISTORY & ANALYTICS ─────────────────────────────────────────────────────

@app.route('/api/history', methods=['GET'])
@require_auth
def history():
    limit = min(int(request.args.get('limit', 100)), 500)
    db = get_db()
    rows = db.execute(
        "SELECT id, emotion, confidence, all_emotions, recorded_at "
        "FROM emotion_records WHERE user_id = ? ORDER BY recorded_at DESC LIMIT ?",
        (g.user_id, limit)
    ).fetchall()
    records = []
    for r in rows:
        records.append({
            'id': r['id'],
            'emotion': r['emotion'],
            'confidence': r['confidence'],
            'all_emotions': json.loads(r['all_emotions'] or '{}'),
            'recorded_at': r['recorded_at']
        })
    return jsonify({'records': records, 'count': len(records)})


@app.route('/api/analytics', methods=['GET'])
@require_auth
def analytics():
    db = get_db()

    # Emotion distribution
    dist = db.execute(
        "SELECT emotion, COUNT(*) as count FROM emotion_records "
        "WHERE user_id = ? GROUP BY emotion ORDER BY count DESC",
        (g.user_id,)
    ).fetchall()

    # Hourly timeline (last 24h)
    timeline = db.execute(
        "SELECT strftime('%H:00', recorded_at) as hour, emotion, COUNT(*) as count "
        "FROM emotion_records WHERE user_id = ? "
        "AND recorded_at >= datetime('now', '-24 hours') "
        "GROUP BY hour, emotion ORDER BY hour",
        (g.user_id,)
    ).fetchall()

    # Daily trend (last 7 days)
    daily = db.execute(
        "SELECT date(recorded_at) as day, emotion, COUNT(*) as count "
        "FROM emotion_records WHERE user_id = ? "
        "AND recorded_at >= date('now', '-7 days') "
        "GROUP BY day, emotion ORDER BY day",
        (g.user_id,)
    ).fetchall()

    # Total stats
    stats = db.execute(
        "SELECT COUNT(*) as total, "
        "AVG(confidence) as avg_confidence, "
        "MAX(recorded_at) as last_seen "
        "FROM emotion_records WHERE user_id = ?",
        (g.user_id,)
    ).fetchone()

    return jsonify({
        'distribution': [{'emotion': r['emotion'], 'count': r['count']} for r in dist],
        'timeline': [{'hour': r['hour'], 'emotion': r['emotion'], 'count': r['count']} for r in timeline],
        'daily': [{'day': r['day'], 'emotion': r['emotion'], 'count': r['count']} for r in daily],
        'stats': {
            'total': stats['total'],
            'avg_confidence': round((stats['avg_confidence'] or 0), 4),
            'last_seen': stats['last_seen']
        }
    })


@app.route('/api/export', methods=['GET'])
@require_auth
def export_data():
    fmt = request.args.get('format', 'json')
    db = get_db()
    rows = db.execute(
        "SELECT emotion, confidence, all_emotions, recorded_at "
        "FROM emotion_records WHERE user_id = ? ORDER BY recorded_at DESC",
        (g.user_id,)
    ).fetchall()

    records = [{
        'emotion': r['emotion'],
        'confidence': r['confidence'],
        'all_emotions': json.loads(r['all_emotions'] or '{}'),
        'recorded_at': r['recorded_at']
    } for r in rows]

    from flask import Response
    if fmt == 'json':
        return Response(
            json.dumps({'username': g.username, 'exported_at': datetime.now().isoformat(),
                        'records': records}, indent=2),
            mimetype='application/json',
            headers={'Content-Disposition': 'attachment; filename=emotion_history.json'}
        )
    # CSV
    import csv
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=['emotion', 'confidence', 'recorded_at'])
    writer.writeheader()
    for r in records:
        writer.writerow({'emotion': r['emotion'], 'confidence': r['confidence'],
                         'recorded_at': r['recorded_at']})
    return Response(
        output.getvalue(),
        mimetype='text/csv',
        headers={'Content-Disposition': 'attachment; filename=emotion_history.csv'}
    )


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'ml_backend': detector.backend,
        'deepface': DEEPFACE_AVAILABLE,
        'fer': FER_AVAILABLE,
        'timestamp': datetime.now().isoformat()
    })


# ─── STARTUP ─────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    init_db()
    logger.info("Starting Emotion Recognition API...")
    app.run(debug=True, host='0.0.0.0', port=5000)
