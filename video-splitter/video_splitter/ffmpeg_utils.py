"""Обёртки над ffmpeg / ffprobe: поиск бинарников, probe, нарезка, извлечение аудио."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass


# На Windows скрываем всплывающее окно консоли у дочерних процессов.
_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


class FfmpegError(RuntimeError):
    """Ошибка выполнения ffmpeg/ffprobe."""


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=_CREATE_NO_WINDOW,
    )


def _candidate_dirs() -> list[str]:
    """Типичные места, где может лежать ffmpeg рядом с приложением или в системе."""
    here = os.path.dirname(os.path.abspath(__file__))
    app_root = os.path.dirname(here)
    dirs = [
        os.path.join(app_root, "ffmpeg", "bin"),
        os.path.join(app_root, "ffmpeg"),
        app_root,
    ]
    if os.name == "nt":
        for base in (
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            r"C:\ffmpeg",
        ):
            dirs.append(os.path.join(base, "ffmpeg", "bin"))
    return dirs


def find_binary(name: str, override: str = "") -> str | None:
    """Ищет ffmpeg/ffprobe: сначала явный путь, затем PATH, затем типичные каталоги.

    `override` может быть путём к бинарнику или к каталогу с ним.
    """
    exe = f"{name}.exe" if os.name == "nt" else name

    if override:
        if os.path.isfile(override):
            return override
        cand = os.path.join(override, exe)
        if os.path.isfile(cand):
            return cand

    found = shutil.which(name)
    if found:
        return found

    for d in _candidate_dirs():
        cand = os.path.join(d, exe)
        if os.path.isfile(cand):
            return cand
    return None


def resolve_tools(ffmpeg_override: str = "") -> tuple[str, str]:
    """Возвращает (ffmpeg, ffprobe) или бросает FfmpegError с понятным сообщением."""
    ffmpeg = find_binary("ffmpeg", ffmpeg_override)
    if not ffmpeg:
        raise FfmpegError(
            "ffmpeg не найден. Установите ffmpeg и добавьте его в PATH, "
            "либо положите ffmpeg.exe в папку 'ffmpeg\\bin' рядом с программой, "
            "либо укажите путь в настройках."
        )
    # ffprobe обычно лежит рядом с ffmpeg
    ffprobe = find_binary("ffprobe", os.path.dirname(ffmpeg)) or find_binary("ffprobe")
    if not ffprobe:
        raise FfmpegError("ffprobe не найден рядом с ffmpeg. Установите полный пакет ffmpeg.")
    return ffmpeg, ffprobe


@dataclass
class MediaInfo:
    duration: float          # секунды
    size_bytes: int          # размер файла
    bit_rate: int            # средний битрейт, бит/с
    has_video: bool
    has_audio: bool

    @property
    def avg_bytes_per_second(self) -> float:
        if self.duration <= 0:
            return 0.0
        return self.size_bytes / self.duration


def probe(path: str, ffprobe: str) -> MediaInfo:
    """Считывает длительность, размер и наличие дорожек через ffprobe."""
    cmd = [
        ffprobe, "-v", "error",
        "-show_entries", "format=duration,size,bit_rate",
        "-show_streams",
        "-of", "json", path,
    ]
    proc = _run(cmd)
    if proc.returncode != 0:
        raise FfmpegError(
            f"Не удалось прочитать файл:\n{proc.stderr.decode('utf-8', 'ignore')[:500]}"
        )
    data = json.loads(proc.stdout.decode("utf-8", "ignore") or "{}")
    fmt = data.get("format", {})
    streams = data.get("streams", [])

    try:
        duration = float(fmt.get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0

    size_bytes = int(fmt.get("size") or os.path.getsize(path))

    try:
        bit_rate = int(fmt.get("bit_rate") or 0)
    except (TypeError, ValueError):
        bit_rate = 0
    if bit_rate <= 0 and duration > 0:
        bit_rate = int(size_bytes * 8 / duration)

    has_video = any(s.get("codec_type") == "video" for s in streams)
    has_audio = any(s.get("codec_type") == "audio" for s in streams)

    return MediaInfo(
        duration=duration,
        size_bytes=size_bytes,
        bit_rate=bit_rate,
        has_video=has_video,
        has_audio=has_audio,
    )
