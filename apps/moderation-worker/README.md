# mwar moderation worker (role=moderator)

Self-hosted, CPU-only image/video moderation for social posts. Tuned for an Intel Core i3-8100T
(4 cores, 35 W) with 8 GB RAM: 2 inference threads (max 3), about 0.5-1.2 GB RSS.

## Policy

| Result | When | Effect |
| --- | --- | --- |
| `reject_prohibited` | Stage 1 (CLIP zero-shot) scores weapons, blood/gore or violence ≥ 0.55, a video is longer than 3 minutes, or the file can't be decoded | Post becomes `rejected`, R2 objects of the whole post deleted at once, author notified (one notification) |
| `mark_nsfw_18` | Stage 2 (NudeNet v3) finds explicit nudity ≥ 0.55 | Post becomes `nsfw_18`: only shown to users who turned on 18+ in /settings |
| `approve_safe` | Everything else | Post becomes `approved` (or `nsfw_18` if the author tagged it 18+) |

Drugs are not scanned. Text-only posts never enter the queue.

## Flow

1. `POST /api/moderation/claim` → up to 15 jobs (max 20), each locked for 300 s.
2. For each job: download via `GET /api/moderation/media?key=...` into `/tmp/mwar-mod/<job>/`.
   Images: Stage 1, then Stage 2. Videos: `ffmpeg -vf fps=0.5,scale=320:-1 -vframes 30`, each frame
   through Stage 1 then Stage 2, with early exit. The job folder is always wiped (`finally`).
3. One `POST /api/moderation/results` per batch (one D1 batch on the API side).
4. Idle backoff 15 → 30 → 60 → 120 s; 2 s pause between busy batches.

All calls send `X-Internal-Secret: $INTERNAL_API_SECRET`.

## Install (Ubuntu 24.04, as root)

Admin → Server Fleet → role **NSFW Moderator** → copy the command, or:

```bash
curl -sSL "https://api.mwar.win/api/nodes/install.sh?token=<NODE_PROVISION_KEY>&role=moderator&node_name=mwar-mod-1" | sudo bash
```

The installer installs python3/venv/ffmpeg, a venv with CPU-only torch (used once by
`prepare_models.py` to export CLIP to ONNX), writes `/opt/mwar-node/.env`
(`INTERNAL_API_SECRET`, `API_URL`, `MOD_CPU_THREADS=2`), and starts PM2 apps
`mwar-nsfw-moderator` + `mwar-heartbeat` (role=moderator, every 180 s) with auto-boot.

## Operate

```bash
curl -s http://127.0.0.1:3100/health      # stats, ram_mb, backend, last_error
pm2 logs mwar-nsfw-moderator
```

Env knobs (in `/opt/mwar-node/.env`): `MOD_CPU_THREADS` (1-3), `MOD_BATCH_SIZE` (1-20),
`MOD_REJECT_THRESHOLD`, `MOD_NSFW_THRESHOLD`, `MOD_BACKEND` (`auto` | `openvino` | `onnxruntime`).
After editing `prompts.json`, re-run `.venv/bin/python prepare_models.py` and `pm2 restart mwar-nsfw-moderator`.

### Multi-media posts and the 480p archive (2026-11-25)

- Each photo / video of a post is its own `scan` job (`media_id` is sent back with the result). The API rejects the
  whole post when any item is rejected; the post becomes visible to others once no item is pending.
- Videos up to 3 minutes: 30 frames are sampled evenly over the whole clip. Downloads are capped at `MAX_DOWNLOAD_MB` (48).
- `transcode_480p` jobs (approved videos older than 30 days, queued by the nightly prune): ffmpeg
  `-vf scale=-2:480 -c:v libx264 -crf 28 -preset veryfast`, uploaded to the job's `upload_url`; when the 480p copy is not
  smaller or ffmpeg fails, the worker calls `upload_url?skip=1` and the original stays.
