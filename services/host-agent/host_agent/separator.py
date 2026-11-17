import importlib.util
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path
from typing import Callable


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


def run_demucs_separation(
    source_path: Path,
    tmp_dir: Path,
    device: str,
    cancel_check: Callable[[], bool],
) -> tuple[Path, Path]:
    """Run local Demucs two-stem vocal separation into tmp_dir and return (instrumental, vocal)."""
    if not has_demucs():
        raise RuntimeError("Demucs is not installed on this host")
    if shutil.which("ffmpeg") is None and source_path.suffix.lower() != ".wav":
        raise RuntimeError("FFmpeg is required to decode non-WAV audio for separation")

    cmd = [
        sys.executable,
        "-m",
        "demucs.separate",
        "--two-stems=vocals",
        "-d",
        device,
        "-o",
        str(tmp_dir),
        str(source_path),
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    while proc.poll() is None:
        if cancel_check():
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
            raise RuntimeError("Cancelled")
        time.sleep(0.25)

    if proc.returncode != 0:
        err = (proc.stderr.read() if proc.stderr else "").strip()
        raise RuntimeError(f"Demucs failed (exit {proc.returncode}): {err[-300:]}")

    inst_matches = list(tmp_dir.rglob("no_vocals.wav"))
    voc_matches = list(tmp_dir.rglob("vocals.wav"))
    if not inst_matches or not voc_matches:
        raise RuntimeError("Demucs finished without expected stem files")
    return inst_matches[0], voc_matches[0]
