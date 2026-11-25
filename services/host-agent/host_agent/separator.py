import importlib.util
import re
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path
from typing import Callable

PROGRESS_RE = re.compile(r"(\d{1,3})%\|")


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


def _decode_to_stereo_wav(source_path: Path, tmp_dir: Path) -> Path:
    """Pre-decode ALAC/EC-3/M4A/FLAC/MP3 to standard 44.1kHz stereo WAV via bundled ffmpeg."""
    if source_path.suffix.lower() == ".wav":
        return source_path
    ffmpeg_exe = find_ffmpeg()
    if not ffmpeg_exe:
        raise RuntimeError("FFmpeg is required to decode non-WAV audio for separation")
    wav_in = tmp_dir / "input.wav"
    proc = subprocess.run(
        [
            ffmpeg_exe,
            "-y",
            "-v",
            "error",
            "-i",
            str(source_path),
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            str(wav_in),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0 or not wav_in.is_file() or wav_in.stat().st_size <= 44:
        raise RuntimeError(f"FFmpeg decode failed: {proc.stderr.strip()[-240:]}")
    return wav_in


def run_demucs_separation(
    source_path: Path,
    tmp_dir: Path,
    device: str,
    cancel_check: Callable[[], bool],
    progress_cb: Callable[[int], None] | None = None,
) -> tuple[Path, Path]:
    """Run local Demucs two-stem vocal separation into tmp_dir and return (instrumental, vocal)."""
    if not has_demucs():
        raise RuntimeError("Demucs is not installed on this host")

    input_wav = _decode_to_stereo_wav(source_path, tmp_dir)
    if cancel_check():
        raise RuntimeError("Cancelled")
    if progress_cb:
        progress_cb(20)

    cmd = [
        sys.executable,
        "-m",
        "demucs.separate",
        "--two-stems=vocals",
        "-d",
        device,
        "-o",
        str(tmp_dir),
        str(input_wav),
    ]
    import threading

    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    stderr_buf: list[str] = []

    def _drain_stderr() -> None:
        if not proc.stderr:
            return
        buf = ""
        while True:
            chunk = proc.stderr.read(128)
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            stderr_buf.append(text)
            buf = (buf + text)[-256:]
            matches = PROGRESS_RE.findall(buf)
            if matches and progress_cb:
                progress_cb(min(95, 20 + int(int(matches[-1]) * 0.75)))

    reader = threading.Thread(target=_drain_stderr, daemon=True)
    reader.start()

    while proc.poll() is None:
        if cancel_check():
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
            raise RuntimeError("Cancelled")
        time.sleep(0.25)

    reader.join(timeout=2)

    if proc.returncode != 0:
        err = "".join(stderr_buf).strip()
        raise RuntimeError(f"Demucs failed (exit {proc.returncode}): {err[-300:]}")

    inst_matches = list(tmp_dir.rglob("no_vocals.wav"))
    voc_matches = list(tmp_dir.rglob("vocals.wav"))
    if not inst_matches or not voc_matches:
        raise RuntimeError("Demucs finished without expected stem files")
    return inst_matches[0], voc_matches[0]
