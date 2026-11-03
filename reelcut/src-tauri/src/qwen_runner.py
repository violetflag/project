"""Qwen3-ASR speech-to-text for Reelcut (run inside the app's own Python environment).

  python qwen_runner.py check
  python qwen_runner.py download --models DIR
  python qwen_runner.py transcribe --models DIR --wav FILE --lang ko --out FILE.json

Progress goes to stderr as "progress = N" lines; errors as "error: ...".
"""
import argparse
import json
import os
import re
import sys
import threading
import time

ASR = "Qwen/Qwen3-ASR-1.7B"
ALIGNER = "Qwen/Qwen3-ForcedAligner-0.6B"
LANGS = {"ko": "Korean", "en": "English", "ja": "Japanese", "zh": "Chinese", "es": "Spanish", "fr": "French", "de": "German"}


def progress(p):
    print(f"progress = {p:.1f}", file=sys.stderr, flush=True)


def local_dir(models, repo):
    return os.path.join(models, repo.split("/")[-1])


def cmd_check(_a):
    out = {"python": sys.version.split()[0]}
    try:
        import torch
        out["torch"] = torch.__version__
        out["cuda"] = bool(torch.cuda.is_available())
        out["gpu"] = torch.cuda.get_device_name(0) if out["cuda"] else ""
        out["vram_gb"] = round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1) if out["cuda"] else 0
    except Exception as e:  # noqa: BLE001
        out["torch_error"] = str(e)
    try:
        import qwen_asr  # noqa: F401
        out["qwen_asr"] = True
    except Exception as e:  # noqa: BLE001
        out["qwen_asr"] = False
        out["qwen_asr_error"] = str(e)
    print(json.dumps(out))


def cmd_download(a):
    from huggingface_hub import HfApi, snapshot_download

    api = HfApi()
    total = 0
    for repo in (ASR, ALIGNER):
        info = api.model_info(repo, files_metadata=True)
        total += sum((s.size or 0) for s in info.siblings)
    done_flag = {"stop": False}

    def size_of(path):
        n = 0
        for root, _d, files in os.walk(path):
            for f in files:
                try:
                    n += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return n

    def watch():
        while not done_flag["stop"]:
            have = sum(size_of(local_dir(a.models, r)) for r in (ASR, ALIGNER))
            progress(min(99.0, have * 100.0 / max(1, total)))
            time.sleep(1.0)

    t = threading.Thread(target=watch, daemon=True)
    t.start()
    try:
        for repo in (ASR, ALIGNER):
            snapshot_download(repo, local_dir=local_dir(a.models, repo))
    finally:
        done_flag["stop"] = True
    progress(100)
    print(json.dumps({"ok": True, "bytes": total}))


KEEP = re.compile(r"[\w]", re.UNICODE)


def core(s):
    """Letters and digits only (what the aligner keeps)."""
    return "".join(ch for ch in s if KEEP.match(ch) and ch != "_")


def to_words(text, items):
    """Maps aligner units (sub-word, no punctuation) back onto the space-separated words of the
    transcript, so each word keeps its punctuation and gets the span of its units."""
    words = text.split()
    out = []
    k = 0
    for w in words:
        need = core(w)
        if not need:
            if out:
                out[-1]["t"] += w
            continue
        got = ""
        s = e = None
        while k < len(items) and len(got) < len(need):
            it = items[k]
            c = core(it.text)
            if c:
                if s is None:
                    s = float(it.start_time)
                e = float(it.end_time)
                got += c
            k += 1
        if s is None:
            # Ran out of units: place right after the previous word.
            s = out[-1]["e"] if out else 0.0
            e = s + 0.2
        out.append({"s": round(s, 3), "e": round(max(e, s + 0.02), 3), "t": w})
    return out


def cmd_transcribe(a):
    import torch
    from qwen_asr import Qwen3ASRModel

    progress(1)
    cuda = torch.cuda.is_available()
    dev = "cuda:0" if cuda else "cpu"
    dtype = torch.bfloat16 if cuda else torch.float32
    asr_path = local_dir(a.models, ASR)
    al_path = local_dir(a.models, ALIGNER)
    if not os.path.isdir(asr_path) or not os.path.isdir(al_path):
        print("error: Qwen 모델이 없습니다. 설정에서 내려받아 주세요.", file=sys.stderr, flush=True)
        sys.exit(2)
    model = Qwen3ASRModel.from_pretrained(
        asr_path, dtype=dtype, device_map=dev, max_inference_batch_size=4 if cuda else 1, max_new_tokens=1024,
        forced_aligner=al_path, forced_aligner_kwargs=dict(dtype=dtype, device_map=dev),
    )
    progress(20)
    lang = LANGS.get(a.lang) if a.lang and a.lang != "auto" else None
    # Long files: transcribe in pieces so progress moves and memory stays flat.
    import soundfile as sf
    import numpy as np

    wav, sr = sf.read(a.wav, dtype="float32")
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    piece = 170 * sr
    words = []
    language = ""
    n = max(1, int(np.ceil(len(wav) / piece)))
    start = 0
    for i in range(n):
        end = min(len(wav), start + piece)
        # Cut at the quietest 0.1 s within the last 8 s of the piece, not mid-word.
        if end < len(wav):
            lo = max(start + sr, end - 8 * sr)
            win = int(0.1 * sr)
            best, best_e = end, None
            for p in range(lo, end - win, win):
                en = float(np.sum(wav[p:p + win] ** 2))
                if best_e is None or en < best_e:
                    best, best_e = p + win // 2, en
            end = best
        chunk = wav[start:end]
        if len(chunk) > sr // 4:
            r = model.transcribe(audio=(chunk, sr), language=lang, return_time_stamps=True)[0]
            language = language or (r.language or "")
            items = list(getattr(r.time_stamps, "items", r.time_stamps) or [])
            off = start / sr
            for w in to_words(r.text or "", items):
                w["s"] = round(w["s"] + off, 3)
                w["e"] = round(w["e"] + off, 3)
                words.append(w)
        start = end
        progress(20 + 79 * (i + 1) / n)
        if start >= len(wav):
            break
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"language": language, "words": words}, f, ensure_ascii=False)
    progress(100)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["check", "download", "transcribe"])
    p.add_argument("--models", default="")
    p.add_argument("--wav", default="")
    p.add_argument("--lang", default="ko")
    p.add_argument("--out", default="")
    a = p.parse_args()
    try:
        {"check": cmd_check, "download": cmd_download, "transcribe": cmd_transcribe}[a.cmd](a)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"error: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
