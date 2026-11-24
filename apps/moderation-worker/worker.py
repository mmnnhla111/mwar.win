#!/usr/bin/env python3
"""
MWAR self-hosted moderation worker (Ubuntu 24.04, CPU only).

Tuned for an Intel Core i3-8100T Mini PC (4 cores, 35 W, 8 GB RAM):
  * every math library is pinned to MOD_CPU_THREADS (default 2, max 3) so 1-2 cores stay free and
    the 35 W cooler never saturates during 24/7 operation;
  * no torch at runtime: Stage 1 CLIP runs as ONNX through OpenVINO (or ONNX Runtime), NudeNet v3 is
    ONNX already -> resident memory stays well under ~1.2 GB.

Content policy (2-stage cascade, prohibited content is checked FIRST):
  Stage 1  CLIP zero-shot vs pre-encoded prompts. Weapons / blood-gore / violence above threshold
           -> reject_prohibited, stage 1, Stage 2 skipped. (Drugs are deliberately not scanned.)
  Stage 2  NudeNet v3 (only for media that passed Stage 1). Explicit nudity >= 0.55
           -> mark_nsfw_18 (allowed, age-gated), else approve_safe.
  Video    ffmpeg keyframes (0.5 fps, 320 px, <= 30 frames); Stage 1 over all frames with early exit,
           then Stage 2 with early exit. Videos longer than 30 s are rejected.

Queue: POST /api/moderation/claim (<= 15 jobs) -> process -> ONE POST /api/moderation/results.
Idle back-off 15 -> 30 -> 60 -> 120 s, 2 s between busy batches.
Health: http://127.0.0.1:3100/health
"""
import os

THREADS = max(1, min(3, int(os.environ.get("MOD_CPU_THREADS", "2") or 2)))
for _k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "ORT_NUM_THREADS", "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ[_k] = str(THREADS)

import json  # noqa: E402
import logging  # noqa: E402
import shutil  # noqa: E402
import signal  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env_file(path: str) -> None:
    """Read KEY=VALUE lines (e.g. /opt/mwar-node/.env) without overriding the real environment."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


load_env_file(os.environ.get("MWAR_ENV_FILE", "/opt/mwar-node/.env"))

API_URL = os.environ.get("API_URL", "https://api.mwar.win").rstrip("/")
SECRET = os.environ.get("INTERNAL_API_SECRET", "")
NODE_NAME = os.environ.get("MOD_NODE_NAME") or os.environ.get("NODE_ID") or "mwar-mod-1"
BATCH_SIZE = max(1, min(20, int(os.environ.get("MOD_BATCH_SIZE", "15"))))
HEALTH_PORT = int(os.environ.get("MOD_HEALTH_PORT", "3100"))
BACKEND = os.environ.get("MOD_BACKEND", "auto").lower()  # auto | openvino | onnxruntime
REJECT_THRESHOLD = float(os.environ.get("MOD_REJECT_THRESHOLD", "0.55"))
NSFW_THRESHOLD = float(os.environ.get("MOD_NSFW_THRESHOLD", "0.55"))
TMP_ROOT = os.environ.get("MOD_TMP_DIR", "/tmp/mwar-mod")
VIDEO_MAX_SECONDS = 30.5
BUSY_PAUSE = 2.0
IDLE_BACKOFF = (15, 30, 60, 120)
EXPLICIT_LABELS = {
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "ANUS_EXPOSED",
    "BUTTOCKS_EXPOSED",
}
PROHIBITED_REASON = {
    "weapons": "Weapons (guns / knives) are not allowed",
    "blood_gore": "Blood / gore / injuries are not allowed",
    "violence": "Physical violence / fighting is not allowed",
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mwar-moderator")

STATS = {
    "node": NODE_NAME,
    "started_at": int(time.time()),
    "processed": 0,
    "rejected": 0,
    "nsfw_18": 0,
    "safe": 0,
    "errors": 0,
    "batches": 0,
    "last_batch_at": None,
    "last_error": None,
    "idle_sleep_s": 0,
    "backend": None,
    "threads": THREADS,
}
STATS_LOCK = threading.Lock()


def bump(key: str, n: int = 1) -> None:
    with STATS_LOCK:
        STATS[key] = STATS.get(key, 0) + n


def rss_mb() -> float:
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except OSError:
        pass
    return 0.0


# ---------------------------------------------------------------------------------------------
# Stage 1: CLIP zero-shot (ONNX via OpenVINO / ONNX Runtime)
# ---------------------------------------------------------------------------------------------
class ClipZeroShot:
    def __init__(self, models_dir: str):
        import numpy as np

        self.np = np
        with open(os.path.join(models_dir, "clip_meta.json"), "r", encoding="utf-8") as f:
            self.meta = json.load(f)
        self.text = np.load(os.path.join(models_dir, "clip_text.npy")).astype("float32")
        self.prompts = self.meta["prompts"]
        self.size = int(self.meta["image_size"])
        self.mean = np.array(self.meta["mean"], dtype="float32").reshape(3, 1, 1)
        self.std = np.array(self.meta["std"], dtype="float32").reshape(3, 1, 1)
        self.scale = float(self.meta.get("logit_scale", 100.0))
        self._check_prompts()
        onnx_path = os.path.join(models_dir, "clip_visual.onnx")
        self.backend, self._run = self._load(onnx_path)

    def _check_prompts(self) -> None:
        try:
            with open(os.path.join(HERE, "prompts.json"), "r", encoding="utf-8") as f:
                current = json.load(f)["prompts"]
            if [p["text"] for p in current] != [p["text"] for p in self.prompts]:
                log.warning("prompts.json changed since prepare_models.py ran; using the prepared prompts. Re-run prepare_models.py.")
        except Exception:  # noqa: BLE001
            pass

    def _load(self, onnx_path: str):
        if BACKEND in ("auto", "openvino"):
            try:
                import openvino as ov

                core = ov.Core()
                compiled = core.compile_model(
                    onnx_path,
                    "CPU",
                    {"INFERENCE_NUM_THREADS": THREADS, "PERFORMANCE_HINT": "LATENCY", "NUM_STREAMS": 1},
                )
                out = compiled.output(0)

                def run(x):
                    return compiled([x])[out]

                return "openvino", run
            except Exception as e:  # noqa: BLE001
                if BACKEND == "openvino":
                    raise
                log.info("OpenVINO unavailable (%s); falling back to ONNX Runtime", e)
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = THREADS
        so.inter_op_num_threads = 1
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        sess = ort.InferenceSession(onnx_path, so, providers=["CPUExecutionProvider"])

        def run(x):
            return sess.run(None, {"pixel_values": x})[0]

        return "onnxruntime", run

    def preprocess(self, img):
        from PIL import Image

        np = self.np
        img = img.convert("RGB")
        w, h = img.size
        s = self.size / min(w, h)
        img = img.resize((max(self.size, round(w * s)), max(self.size, round(h * s))), Image.BICUBIC)
        w, h = img.size
        left, top = (w - self.size) // 2, (h - self.size) // 2
        img = img.crop((left, top, left + self.size, top + self.size))
        x = np.asarray(img, dtype="float32").transpose(2, 0, 1) / 255.0
        x = (x - self.mean) / self.std
        return x[None, ...].astype("float32")

    def classify(self, img) -> dict:
        """Returns {category: probability} summed over prompts (softmax over all prompts)."""
        np = self.np
        emb = self._run(self.preprocess(img)).astype("float32")[0]
        emb = emb / (np.linalg.norm(emb) + 1e-8)
        logits = self.scale * (self.text @ emb)
        logits = logits - logits.max()
        p = np.exp(logits)
        p = p / p.sum()
        out: dict = {}
        for prompt, prob in zip(self.prompts, p.tolist()):
            out[prompt["category"]] = out.get(prompt["category"], 0.0) + prob
        return out

    def prohibited(self, img):
        """(category, score) when a prohibited category is over threshold, else (None, top_score)."""
        probs = self.classify(img)
        kinds = {p["category"]: p["kind"] for p in self.prompts}
        bad = [(c, s) for c, s in probs.items() if kinds.get(c) == "prohibited"]
        cat, score = max(bad, key=lambda t: t[1]) if bad else (None, 0.0)
        if cat and score >= REJECT_THRESHOLD:
            return cat, score
        return None, score


# ---------------------------------------------------------------------------------------------
# Stage 2: NudeNet v3 (ONNX) — categorises 18+, never rejects
# ---------------------------------------------------------------------------------------------
class NudityCategorizer:
    def __init__(self):
        from nudenet import NudeDetector

        self.det = NudeDetector()
        self._cap_threads()

    def _cap_threads(self) -> None:
        """NudeNet builds its own ONNX session; rebuild it with the same thread cap as Stage 1."""
        try:
            import onnxruntime as ort

            sess = getattr(self.det, "onnx_session", None)
            path = getattr(sess, "_model_path", None)
            if sess is not None and path:
                so = ort.SessionOptions()
                so.intra_op_num_threads = THREADS
                so.inter_op_num_threads = 1
                self.det.onnx_session = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
        except Exception as e:  # noqa: BLE001
            log.warning("could not cap NudeNet threads (%s); relying on OMP/ORT env caps", e)

    def explicit_score(self, image_path: str) -> float:
        best = 0.0
        for d in self.det.detect(image_path) or []:
            label = d.get("class") or d.get("label")
            if label in EXPLICIT_LABELS:
                best = max(best, float(d.get("score", 0.0)))
        return best


# ---------------------------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------------------------
class Pipeline:
    def __init__(self):
        models_dir = os.path.join(HERE, "models")
        self.clip = ClipZeroShot(models_dir)
        self.nude = NudityCategorizer()
        STATS["backend"] = self.clip.backend
        log.info("models ready: stage1=%s (%s) stage2=NudeNet v3, threads=%d, rss=%.0f MB", self.meta_name(), self.clip.backend, THREADS, rss_mb())

    def meta_name(self) -> str:
        m = self.clip.meta
        return f"{m.get('model')}/{m.get('pretrained')}"

    def image(self, path: str) -> dict:
        from PIL import Image

        with Image.open(path) as img:
            img.load()
            cat, score = self.clip.prohibited(img)
        if cat:
            return {"action": "reject_prohibited", "reason": PROHIBITED_REASON.get(cat, cat), "score": round(score, 4), "stage_stopped": 1}
        nude = self.nude.explicit_score(path)
        if nude >= NSFW_THRESHOLD:
            return {"action": "mark_nsfw_18", "reason": "Explicit nudity (18+)", "score": round(nude, 4), "stage_stopped": 2}
        return {"action": "approve_safe", "score": round(max(score, nude), 4), "stage_stopped": 2}

    def video(self, path: str, workdir: str) -> dict:
        from PIL import Image

        dur = probe_duration(path)
        if dur is not None and dur > VIDEO_MAX_SECONDS:
            return {"action": "reject_prohibited", "reason": "Video longer than 30 seconds", "score": 1.0, "stage_stopped": 1}
        frames_dir = os.path.join(workdir, "frames")
        os.makedirs(frames_dir, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-threads", str(THREADS), "-y", "-i", path,
             "-vf", "fps=0.5,scale=320:-1", "-vframes", "30", os.path.join(frames_dir, "frame_%03d.jpg")],
            check=True,
            timeout=120,
        )
        frames = sorted(os.path.join(frames_dir, f) for f in os.listdir(frames_dir) if f.endswith(".jpg"))
        if not frames:
            raise ValueError("no frames decoded")
        top = 0.0
        for fp in frames:  # Stage 1 with early exit
            with Image.open(fp) as img:
                img.load()
                cat, score = self.clip.prohibited(img)
            top = max(top, score)
            if cat:
                return {"action": "reject_prohibited", "reason": PROHIBITED_REASON.get(cat, cat), "score": round(score, 4), "stage_stopped": 1}
        for fp in frames:  # Stage 2 with early exit
            nude = self.nude.explicit_score(fp)
            top = max(top, nude)
            if nude >= NSFW_THRESHOLD:
                return {"action": "mark_nsfw_18", "reason": "Explicit nudity (18+)", "score": round(nude, 4), "stage_stopped": 2}
        return {"action": "approve_safe", "score": round(top, 4), "stage_stopped": 2}


def probe_duration(path: str):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout.strip()
        return float(out) if out and out != "N/A" else None
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------------------------
class Api:
    def __init__(self):
        import requests

        self.s = requests.Session()
        self.s.headers.update({"X-Internal-Secret": SECRET, "User-Agent": "mwar-moderation-worker/1.0"})

    def claim(self) -> list:
        r = self.s.post(f"{API_URL}/api/moderation/claim", json={"node_name": NODE_NAME, "batch_size": BATCH_SIZE}, timeout=30)
        r.raise_for_status()
        return r.json().get("jobs", [])

    def download(self, job: dict, dest: str) -> None:
        with self.s.get(job["download_url"], timeout=60, stream=True) as r:
            r.raise_for_status()
            size = 0
            with open(dest, "wb") as f:
                for chunk in r.iter_content(64 * 1024):
                    size += len(chunk)
                    if size > 6 * 1024 * 1024:
                        raise ValueError("media larger than 6 MB")
                    f.write(chunk)

    def submit(self, results: list) -> dict:
        last = None
        for attempt in range(3):
            try:
                r = self.s.post(f"{API_URL}/api/moderation/results", json={"node_name": NODE_NAME, "results": results}, timeout=30)
                r.raise_for_status()
                return r.json()
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"submit failed: {last}")


def process_job(pipe: Pipeline, api: Api, job: dict):
    """Returns a result dict, or None to leave the job for a retry (lock expires after 300 s)."""
    workdir = os.path.join(TMP_ROOT, str(job["job_id"]))
    os.makedirs(workdir, exist_ok=True)
    try:
        ext = os.path.splitext(job.get("media_key", ""))[1] or ".bin"
        path = os.path.join(workdir, f"media{ext}")
        try:
            api.download(job, path)
        except Exception as e:  # noqa: BLE001
            log.warning("job %s download failed: %s", job["job_id"], e)
            bump("errors")
            return None
        try:
            res = pipe.video(path, workdir) if job.get("media_type") == "video" else pipe.image(path)
        except Exception as e:  # noqa: BLE001
            # Undecodable / corrupt media cannot be shown anyway: reject it so R2 is purged
            log.warning("job %s unreadable media: %s", job["job_id"], e)
            bump("errors")
            res = {"action": "reject_prohibited", "reason": "Unreadable or corrupted media", "score": 0.0, "stage_stopped": 1}
        res.update({"job_id": job["job_id"], "post_id": job["post_id"]})
        return res
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def count_result(res: dict) -> None:
    bump("processed")
    bump({"reject_prohibited": "rejected", "mark_nsfw_18": "nsfw_18"}.get(res["action"], "safe"))


# ---------------------------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------------------------
class Health(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] != "/health":
            self.send_response(404)
            self.end_headers()
            return
        with STATS_LOCK:
            body = dict(STATS)
        body.update({"status": "ok", "ram_mb": rss_mb(), "active_threads": threading.active_count(), "uptime_s": int(time.time()) - STATS["started_at"]})
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # quiet
        return


def start_health() -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", HEALTH_PORT), Health)
    threading.Thread(target=srv.serve_forever, name="health", daemon=True).start()
    log.info("health endpoint on http://127.0.0.1:%d/health", HEALTH_PORT)


# ---------------------------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------------------------
RUNNING = True


def _stop(*_):
    global RUNNING
    RUNNING = False


def main() -> int:
    if not SECRET:
        log.error("INTERNAL_API_SECRET is not set (expected in /opt/mwar-node/.env)")
        return 2
    os.makedirs(TMP_ROOT, exist_ok=True)
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    start_health()
    pipe = Pipeline()
    api = Api()
    idle = 0
    while RUNNING:
        try:
            jobs = api.claim()
        except Exception as e:  # noqa: BLE001
            log.warning("claim failed: %s", e)
            with STATS_LOCK:
                STATS["last_error"] = str(e)[:200]
            jobs = []
        if not jobs:
            wait = IDLE_BACKOFF[min(idle, len(IDLE_BACKOFF) - 1)]
            idle += 1
            STATS["idle_sleep_s"] = wait
            sleep(wait)
            continue
        idle = 0
        STATS["idle_sleep_s"] = 0
        t0 = time.time()
        results = []
        for job in jobs:
            if not RUNNING:
                break
            res = process_job(pipe, api, job)
            if res:
                results.append(res)
        if results:
            try:
                api.submit(results)
                for r in results:
                    count_result(r)
            except Exception as e:  # noqa: BLE001
                log.error("%s (jobs will be re-claimed after the 300 s lock)", e)
                bump("errors")
                with STATS_LOCK:
                    STATS["last_error"] = str(e)[:200]
        bump("batches")
        STATS["last_batch_at"] = int(time.time())
        log.info("batch: %d jobs, %d results in %.1fs (rss %.0f MB)", len(jobs), len(results), time.time() - t0, rss_mb())
        sleep(BUSY_PAUSE)
    log.info("stopped")
    return 0


def sleep(seconds: float) -> None:
    end = time.time() + seconds
    while RUNNING and time.time() < end:
        time.sleep(min(1.0, end - time.time()))


if __name__ == "__main__":
    sys.exit(main())
