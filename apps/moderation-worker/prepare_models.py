#!/usr/bin/env python3
"""
One-time model preparation for the MWAR moderation worker (run by the installer, CPU only).

1. Loads an open_clip model (default ViT-B-32 / laion2b_s34b_b79k; MobileCLIP-S1 also works with a
   recent open-clip-torch + timm) with PyTorch on CPU.
2. Pre-encodes the Stage 1 prompts (prompts.json) ONCE -> models/clip_text.npy (L2-normalised).
3. Exports the image encoder to ONNX -> models/clip_visual.onnx, so the worker runs it through
   OpenVINO or ONNX Runtime with a hard thread cap and never imports torch at runtime (lower RAM).
4. Instantiates NudeNet v3 once so its ONNX detector is cached locally.

Env: MOD_CLIP_MODEL, MOD_CLIP_PRETRAINED, MOD_CPU_THREADS (default 2, max 3).
"""
import hashlib
import json
import os
import sys
import time

THREADS = max(1, min(3, int(os.environ.get("MOD_CPU_THREADS", "2") or 2)))
for _k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "ORT_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_k] = str(THREADS)

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")
MODEL_NAME = os.environ.get("MOD_CLIP_MODEL", "ViT-B-32")
PRETRAINED = os.environ.get("MOD_CLIP_PRETRAINED", "laion2b_s34b_b79k")
OPENAI_MEAN = (0.48145466, 0.4578275, 0.40821073)
OPENAI_STD = (0.26862954, 0.26130258, 0.27577711)


def prompts_and_hash():
    with open(os.path.join(HERE, "prompts.json"), "r", encoding="utf-8") as f:
        raw = f.read()
    data = json.loads(raw)
    return data["prompts"], hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def main() -> int:
    import numpy as np
    import torch
    import open_clip

    torch.set_num_threads(THREADS)
    os.makedirs(MODELS, exist_ok=True)
    prompts, phash = prompts_and_hash()

    t0 = time.time()
    print(f"[prepare] loading open_clip {MODEL_NAME} / {PRETRAINED} on CPU ({THREADS} threads)...", flush=True)
    model, _, _ = open_clip.create_model_and_transforms(MODEL_NAME, pretrained=PRETRAINED, device="cpu")
    model.eval()
    tokenizer = open_clip.get_tokenizer(MODEL_NAME)

    with torch.no_grad():
        tokens = tokenizer([p["text"] for p in prompts])
        text = model.encode_text(tokens).float()
        text = text / text.norm(dim=-1, keepdim=True)
    np.save(os.path.join(MODELS, "clip_text.npy"), text.cpu().numpy().astype("float32"))

    cfg = getattr(model.visual, "preprocess_cfg", None) or {}
    size = cfg.get("size") or getattr(model.visual, "image_size", 224)
    if isinstance(size, (list, tuple)):
        size = int(size[0])
    mean = tuple(cfg.get("mean") or OPENAI_MEAN)
    std = tuple(cfg.get("std") or OPENAI_STD)
    logit_scale = float(model.logit_scale.exp().item()) if hasattr(model, "logit_scale") else 100.0

    class Visual(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            return self.m.encode_image(pixel_values)

    onnx_path = os.path.join(MODELS, "clip_visual.onnx")
    if os.path.exists(onnx_path):
        try:
            os.remove(onnx_path)
        except OSError:
            pass
    dummy = torch.randn(1, 3, int(size), int(size))
    print(f"[prepare] exporting image encoder to {onnx_path} ...", flush=True)
    with torch.no_grad():
        export_kwargs = {
            "input_names": ["pixel_values"],
            "output_names": ["image_embeds"],
            "dynamic_axes": {"pixel_values": {0: "batch"}, "image_embeds": {0: "batch"}},
            "opset_version": 17,
            "do_constant_folding": True,
        }
        try:
            torch.onnx.export(
                Visual(model).eval(),
                dummy,
                onnx_path,
                dynamo=False,
                **export_kwargs,
            )
        except TypeError:
            torch.onnx.export(
                Visual(model).eval(),
                dummy,
                onnx_path,
                **export_kwargs,
            )
        ref = model.encode_image(dummy).float().numpy()

    # Sanity check: ONNX Runtime output must match PyTorch
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = THREADS
    so.inter_op_num_threads = 1
    sess = ort.InferenceSession(onnx_path, so, providers=["CPUExecutionProvider"])
    out = sess.run(None, {"pixel_values": dummy.numpy()})[0]
    err = float(abs(out - ref).max())
    print(f"[prepare] ONNX vs torch max abs diff: {err:.5f}", flush=True)
    if err > 1e-2:
        print("[prepare] WARNING: ONNX output differs from torch more than expected", file=sys.stderr)

    meta = {
        "model": MODEL_NAME,
        "pretrained": PRETRAINED,
        "image_size": int(size),
        "mean": list(mean),
        "std": list(std),
        "logit_scale": logit_scale,
        "prompts": prompts,
        "prompts_hash": phash,
        "created_at": int(time.time()),
    }
    with open(os.path.join(MODELS, "clip_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print("[prepare] warming NudeNet v3 detector...", flush=True)
    from nudenet import NudeDetector

    NudeDetector()
    print(f"[prepare] done in {time.time() - t0:.1f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
