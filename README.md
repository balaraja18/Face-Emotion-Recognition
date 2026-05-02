# 👁 EmoSense — Real-Time Face Emotion Recognition Web App

A production-ready full-stack web application that detects and classifies human emotions in real-time using your webcam, powered by **DeepFace**, **Flask**, and **SQLite**.

---

## 🏗 Architecture

```
Browser (HTML/CSS/JS)
       │
       │  getUserMedia() → webcam frames
       │  base64 encode → POST /api/predict
       ↓
Flask REST API (Python)
       │
       ├── /api/auth/login|signup|logout   ← JWT-style token auth
       ├── /api/predict                    ← ML inference endpoint
       ├── /api/history                    ← Emotion history
       ├── /api/analytics                  ← Charts data
       └── /api/export                     ← Download JSON/CSV
       │
       ├── DeepFace (primary) → RetinaFace + EfficientNet
       ├── FER (fallback)     → MTCNN + mini-Xception
       └── OpenCV (fallback)  → Haar cascade (no emotion score)
       │
SQLite Database
       ├── users
       ├── sessions
       └── emotion_records
```

### Flow:
1. User logs in → receives Bearer token
2. Camera starts → frames captured every 600ms
3. Frame → base64 → POST to `/api/predict`
4. DeepFace detects face, classifies 7 emotions
5. Result (emotion + confidence + breakdown) → overlay on video
6. Record stored in SQLite under user's account
7. Dashboard reads analytics from DB → rendered with Chart.js

---

## 📁 Project Structure

```
emotion-recognition-app/
├── frontend/
│   ├── index.html      ← Single-page app (auth + camera + dashboard + history)
│   ├── styles.css      ← Dark sci-fi theme, responsive
│   └── script.js       ← Webcam capture, API calls, chart rendering
├── backend/
│   └── app.py          ← Flask API (auth + ML + DB + export)
├── database/
│   └── emotions.db     ← Auto-created by Flask on first run
├── requirements.txt    ← Python dependencies
└── README.md
```

---

## ⚙️ Setup & Run

### Prerequisites
- Python 3.9+
- pip
- A webcam
- Modern browser (Chrome/Firefox/Edge)

---

### Step 1: Install Python dependencies

```bash
cd emotion-recognition-app

# Create virtual environment (recommended)
python -m venv venv
source venv/bin/activate        # Linux/Mac
venv\Scripts\activate           # Windows

# Install dependencies
pip install -r requirements.txt
```

> ⚠️ **Note:** `deepface` and `tensorflow` are large (~2GB). First install may take several minutes.
>
> If TensorFlow fails on your system, try the lighter `fer` package only:
> ```
> pip install flask flask-cors fer opencv-python pillow numpy
> ```

---

### Step 2: Run the Flask backend

```bash
cd backend
python app.py
```

You should see:
```
Database initialized at .../database/emotions.db
Starting Emotion Recognition API...
 * Running on http://0.0.0.0:5000
```

---

### Step 3: Open the frontend

Open `frontend/index.html` in your browser.

> **Important:** Open via `http://`, not `file://`, to allow webcam access.
>
> **Quick way:** Install `live-server` or use Python's HTTP server:
> ```bash
> # From the project root:
> python -m http.server 8080
> # Then open: http://localhost:8080/frontend/
> ```

---

### Step 4: Use the app

1. **Sign up** with username, email, password
2. Click **Start Camera**
3. Allow webcam permission in browser
4. Watch real-time emotion detection with confidence scores
5. Visit **Dashboard** to see charts and analytics
6. Visit **History** for your emotion log
7. Export data as **JSON** or **CSV**

---

## 🤖 ML Model Details

| Backend   | Model                  | Speed   | Accuracy |
|-----------|------------------------|---------|----------|
| DeepFace  | RetinaFace + EfficientNet | ~300ms | High    |
| FER       | MTCNN + mini-Xception  | ~150ms  | Medium   |
| OpenCV    | Haar Cascade (face only)| ~50ms  | Face detect only |

**Detected Emotions:** Happy, Sad, Angry, Fear, Surprise, Disgust, Neutral

The app auto-selects the best available backend on startup.

---

## 🗄 Database Schema

```sql
users          (id, username, email, password_hash, created_at)
sessions       (id, user_id, token, expires_at)
emotion_records(id, user_id, emotion, confidence, all_emotions JSON, recorded_at)
```

---

## 🔌 API Reference

| Method | Endpoint              | Auth | Description              |
|--------|-----------------------|------|--------------------------|
| POST   | /api/auth/signup      | —    | Create account            |
| POST   | /api/auth/login       | —    | Login → get token         |
| POST   | /api/auth/logout      | ✓    | Invalidate token          |
| GET    | /api/auth/me          | ✓    | Current user info         |
| POST   | /api/predict          | ✓    | Predict emotion from image|
| GET    | /api/history          | ✓    | Emotion history           |
| GET    | /api/analytics        | ✓    | Charts data               |
| GET    | /api/export?format=json| ✓   | Download history          |
| GET    | /api/health           | —    | Backend health check      |

### Example: /api/predict

**Request:**
```json
{ "image": "data:image/jpeg;base64,/9j/4AAQ..." }
```

**Response:**
```json
{
  "face_detected": true,
  "emotion": "happy",
  "confidence": 0.9234,
  "all_emotions": {
    "happy": 0.9234, "neutral": 0.0421, "sad": 0.0132,
    "angry": 0.0089, "surprise": 0.0067, "fear": 0.0045, "disgust": 0.0012
  },
  "emoji": "😄",
  "faces_count": 1,
  "processing_ms": 287.4
}
```

---

## 🚀 Production Deployment

```bash
# Use gunicorn instead of Flask dev server
pip install gunicorn
gunicorn -w 2 -b 0.0.0.0:5000 app:app

# Serve frontend with nginx or any static host
```

---

## 🛠 Troubleshooting

| Issue | Solution |
|-------|----------|
| Camera not working | Use http://localhost (not file://) |
| CORS errors | Ensure Flask is on port 5000, CORS is enabled |
| DeepFace slow first run | It downloads model weights (~600MB) on first use |
| TensorFlow install fails | Try `pip install tensorflow-cpu` instead |
| No emotions detected | Ensure good lighting, face the camera directly |

---

## 📦 Tech Stack

- **Frontend:** Vanilla HTML5, CSS3, JavaScript (ES6+), Chart.js 4
- **Backend:** Python 3.9+, Flask 3, Flask-CORS
- **ML:** DeepFace (RetinaFace + EfficientNet), FER (MTCNN + Xception)
- **Database:** SQLite 3
- **Fonts:** Syne, DM Sans, DM Mono (Google Fonts)
