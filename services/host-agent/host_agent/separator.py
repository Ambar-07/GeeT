from __future__ import annotations

import contextlib
import importlib.util
import os
import shutil
import subprocess
import threading
import wave
from pathlib import Path
from typing import Any, Callable

import numpy as np

DEFAULT_MODEL_NAME = os.getenv("GEET_DEMUCS_MODEL", "htdemucs").strip() or "htdemucs"
DEFAULT_OVERLAP = float(os.getenv("GEET_DEMUCS_OVERLAP", "0.1"))
DEFAULT_SHIFTS = int(os.getenv("GEET_DEMUCS_SHIFTS", "0"))

_MODEL_LOCK = threading.Lock()
_MODEL_CACHE: dict[tuple[str, str], Any] = {}


class _SeparationCancelled(RuntimeError):
    pass


def find_ffmpeg() -> str | None:
    """Locate system ffmpeg or bundled imageio-ffmpeg binary."""
    system = shutil.which("ffmpeg")
    if system:
        return system
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        return exe if exe and Path(exe).is_file() else None
    except Exception:
        return None


def detect_compute_device() -> str:
    """Detect GPU compute availability; fall back cleanly to CPU."""
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def has_demucs() -> bool:
    return shutil.which("demucs") is not None or importlib.util.find_spec("demucs") is not None


def _wav_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as w:
        rate = w.getframerate()
        if rate <= 0:
            return 0
        return int((w.getnframes() / rate) * 1000)


def verify_stem_integrity(stem_path: Path, expected_duration_ms: int = 0) -> None:
    """Verify separated stem is non-empty and matches source duration before cache promotion."""
    if not stem_path.is_file():
        raise RuntimeError(f"Missing separated stem: {stem_path.name}")
    if stem_path.stat().st_size <= 44:
        raise RuntimeError(f"Empty stem file: {stem_path.name}")

    if stem_path.suffix.lower() == ".wav":
        stem_ms = _wav_duration_ms(stem_path)
        if stem_ms <= 0:
            raise RuntimeError(f"Invalid WAV duration in {stem_path.name}")
        if expected_duration_ms > 0 and abs(stem_ms - expected_duration_ms) > 3000:
            raise RuntimeError(
                f"Stem duration mismatch ({stem_ms}ms vs expected {expected_duration_ms}ms)"
            )


def _decode_to_float32_stereo(source_path: Path, sample_rate: int = 44100) -> np.ndarray:
    """Decode any audio file directly to an in-memory (2, N) float32 array via FFmpeg pipe."""
    ffmpeg_exe = find_ffmpeg()
    if not ffmpeg_exe:
        raise RuntimeError("FFmpeg is required to decode audio for separation")

    proc = subprocess.run(
        [
            ffmpeg_exe,
            "-v",
            "error",
            "-i",
            str(source_path),
            "-vn",
            "-ac",
            "2",
            "-ar",
            str(sample_rate),
            "-f",
            "f32le",
            "pipe:1",
        ],
        capture_output=True,
        timeout=120,
    )
    if proc.returncode != 0 or len(proc.stdout) < 8:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"FFmpeg decode failed: {err[-240:]}")

    frame_bytes = (len(proc.stdout) // 8) * 8
    interleaved = np.frombuffer(proc.stdout[:frame_bytes], dtype="<f4").reshape(-1, 2)
    return np.ascontiguousarray(interleaved.T, dtype=np.float32)


def _write_stereo_wav(path: Path, audio_2ch: np.ndarray, sample_rate: int = 44100) -> None:
    """Write a (2, N) float32 array cleanly to a 16-bit PCM stereo WAV file."""
    clipped = np.clip(audio_2ch, -1.0, 1.0)
    pcm16 = np.rint(clipped.T * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm16.tobytes())


def _get_cached_model(model_name: str, device: str) -> Any:
    """Load Demucs model once per (model, device) and keep weights warm in memory/VRAM."""
    key = (model_name, device)
    with _MODEL_LOCK:
        cached = _MODEL_CACHE.get(key)
        if cached is not None:
            return cached

        import torch
        from demucs.pretrained import get_model

        if device == "cuda" and torch.cuda.is_available():
            torch.backends.cudnn.benchmark = True
            torch.set_float32_matmul_precision("high")
        elif device == "cpu":
            cores = os.cpu_count() or 4
            torch.set_num_threads(max(1, min(cores, 8)))

        model = get_model(model_name)
        model.eval()
        model.to(device)
        _MODEL_CACHE[key] = model
        return model


def _run_apply_model(
    model: Any,
    norm_mix: Any,
    device: str,
    overlap: float,
    shifts: int,
    segment: float | None,
    callback: Callable[[dict[str, Any]], None],
    audio_length: int,
) -> Any:
    import torch
    from demucs.apply import apply_model

    amp_ctx = (
        torch.amp.autocast("cuda", dtype=torch.float16)
        if device == "cuda"
        else contextlib.nullcontext()
    )
    with torch.inference_mode(), amp_ctx:
        return apply_model(
            model,
            norm_mix,
            shifts=shifts,
            split=True,
            overlap=overlap,
            device=device,
            num_workers=0,
            segment=segment,
            progress=False,
            callback=callback,
            callback_arg={"audio_length": audio_length},
        )


def run_demucs_separation(
    source_path: Path,
    tmp_dir: Path,
    device: str,
    cancel_check: Callable[[], bool],
    progress_cb: Callable[[int], None] | None = None,
) -> tuple[Path, Path]:
    """Run warm in-process Demucs two-stem vocal separation and return (instrumental, vocal)."""
    if not has_demucs():
        raise RuntimeError("Demucs is not installed on this host")
    if cancel_check():
        raise RuntimeError("Cancelled")

    import torch

    model = _get_cached_model(DEFAULT_MODEL_NAME, device)
    sample_rate = int(getattr(model, "samplerate", 44100))
    if cancel_check():
        raise RuntimeError("Cancelled")
    if progress_cb:
        progress_cb(15)

    wav_np = _decode_to_float32_stereo(source_path, sample_rate=sample_rate)
    if cancel_check():
        raise RuntimeError("Cancelled")
    if progress_cb:
        progress_cb(22)

    audio_length = int(wav_np.shape[1])
    wav = torch.from_numpy(wav_np)
    ref = wav.mean(0)
    mean = ref.mean()
    std = ref.std() + 1e-8
    norm_mix = ((wav - mean) / std).unsqueeze(0)

    last_pct = 22

    def _on_segment(info: dict[str, Any]) -> None:
        nonlocal last_pct
        if cancel_check():
            raise _SeparationCancelled("Cancelled")
        if not progress_cb:
            return
        total = max(1, int(info.get("audio_length") or audio_length))
        offset = int(info.get("segment_offset") or 0)
        models_count = max(1, int(info.get("models") or 1))
        model_idx = int(info.get("model_idx_in_bag") or 0)
        # Estimate fraction across segments & sub-models
        seg_frac = min(1.0, offset / total)
        if info.get("state") == "end":
            seg_frac = min(1.0, seg_frac + 0.08)
        overall = (model_idx + seg_frac) / models_count
        pct = min(93, 22 + int(overall * 71))
        if pct > last_pct:
            last_pct = pct
            progress_cb(pct)

    overlap = max(0.05, min(0.5, DEFAULT_OVERLAP))
    shifts = max(0, DEFAULT_SHIFTS)

    try:
        try:
            out = _run_apply_model(
                model,
                norm_mix,
                device=device,
                overlap=overlap,
                shifts=shifts,
                segment=None,
                callback=_on_segment,
                audio_length=audio_length,
            )
        except _SeparationCancelled:
            raise RuntimeError("Cancelled")
        except RuntimeError as exc:
            # Handle 4-6GB laptop GPU OOM cleanly by retrying with smaller segment before CPU fallback
            if device == "cuda" and "out of memory" in str(exc).lower():
                torch.cuda.empty_cache()
                try:
                    out = _run_apply_model(
                        model,
                        norm_mix,
                        device="cuda",
                        overlap=overlap,
                        shifts=0,
                        segment=5.0,
                        callback=_on_segment,
                        audio_length=audio_length,
                    )
                except _SeparationCancelled:
                    raise RuntimeError("Cancelled")
            else:
                raise
    finally:
        if device == "cuda" and torch.cuda.is_available():
            torch.cuda.empty_cache()

    if cancel_check():
        raise RuntimeError("Cancelled")

    stems = (out[0].float().cpu() * std + mean).numpy()
    sources = list(model.sources)
    if "vocals" not in sources:
        raise RuntimeError(f"Demucs model {DEFAULT_MODEL_NAME} has no vocals stem")

    voc_idx = sources.index("vocals")
    vocals = stems[voc_idx]
    no_vocals = np.sum(np.delete(stems, voc_idx, axis=0), axis=0)

    if progress_cb:
        progress_cb(96)

    tmp_dir.mkdir(parents=True, exist_ok=True)
    inst_path = tmp_dir / "no_vocals.wav"
    voc_path = tmp_dir / "vocals.wav"
    _write_stereo_wav(inst_path, no_vocals, sample_rate=sample_rate)
    _write_stereo_wav(voc_path, vocals, sample_rate=sample_rate)
    return inst_path, voc_path
