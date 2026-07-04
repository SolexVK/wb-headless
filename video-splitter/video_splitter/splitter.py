"""Нарезка видео на куски заданного размера без перекодирования (stream copy).

Подход: ffmpeg сегментирует поток только по ключевым кадрам, поэтому точный
размер байт-в-байт недостижим при копировании потока. Мы оцениваем целевую
длительность сегмента исходя из среднего битрейта файла и режем segment-муксером.
Реальные размеры кусков будут близки к цели (обычно ±10-15%).
"""

from __future__ import annotations

import glob
import math
import os
from dataclasses import dataclass
from typing import Callable

from .ffmpeg_utils import FfmpegError, MediaInfo, _run, probe, resolve_tools

ProgressCb = Callable[[str], None]

MB = 1024 * 1024


@dataclass
class SplitPlan:
    target_bytes: int
    segment_seconds: float
    estimated_parts: int


def plan_split(info: MediaInfo, target_size_mb: int) -> SplitPlan:
    """Рассчитывает длительность сегмента для нужного размера куска."""
    if target_size_mb <= 0:
        raise ValueError("Размер куска должен быть положительным.")
    target_bytes = target_size_mb * MB
    bps = info.avg_bytes_per_second
    if bps <= 0:
        raise FfmpegError("Не удалось определить битрейт/длительность файла.")

    segment_seconds = target_bytes / bps
    # Защита от абсурдно коротких сегментов на «тяжёлых» файлах.
    segment_seconds = max(segment_seconds, 1.0)

    estimated_parts = max(1, math.ceil(info.size_bytes / target_bytes))
    return SplitPlan(
        target_bytes=target_bytes,
        segment_seconds=segment_seconds,
        estimated_parts=estimated_parts,
    )


def split_video(
    input_path: str,
    output_dir: str,
    target_size_mb: int,
    ffmpeg_override: str = "",
    progress: ProgressCb | None = None,
) -> list[str]:
    """Режет видео на куски ~target_size_mb МБ. Возвращает список файлов-кусков.

    Использует stream copy (без перекодирования) — быстро и без потери качества.
    """
    log = progress or (lambda _m: None)
    ffmpeg, ffprobe = resolve_tools(ffmpeg_override)

    if not os.path.isfile(input_path):
        raise FfmpegError(f"Файл не найден: {input_path}")
    os.makedirs(output_dir, exist_ok=True)

    log("Анализ файла…")
    info = probe(input_path, ffprobe)
    if not info.has_video and not info.has_audio:
        raise FfmpegError("В файле нет ни видео-, ни аудиодорожки.")

    plan = plan_split(info, target_size_mb)
    log(
        f"Длительность: {_fmt_dur(info.duration)}, размер: {info.size_bytes / MB:.0f} МБ, "
        f"битрейт: {info.bit_rate / 1_000_000:.2f} Мбит/с"
    )
    log(
        f"Цель: ~{target_size_mb} МБ/кусок → длина сегмента ~{_fmt_dur(plan.segment_seconds)}, "
        f"ожидается ~{plan.estimated_parts} кусок(ов)."
    )

    base = os.path.splitext(os.path.basename(input_path))[0]
    ext = os.path.splitext(input_path)[1] or ".mp4"
    # %03d — сквозная нумерация кусков.
    pattern = os.path.join(output_dir, f"{base}_part%03d{ext}")

    # Подчистим старые куски с тем же префиксом, чтобы не путаться в нумерации.
    for old in glob.glob(os.path.join(output_dir, f"{base}_part*{ext}")):
        try:
            os.remove(old)
        except OSError:
            pass

    cmd = [
        ffmpeg, "-hide_banner", "-y",
        "-i", input_path,
        "-c", "copy",
        "-map", "0",
        "-f", "segment",
        "-segment_time", f"{plan.segment_seconds:.3f}",
        "-reset_timestamps", "1",
        # Резать по ключевым кадрам видео (иначе куски могут начинаться «с чёрного»).
        "-break_non_keyframes", "0",
        pattern,
    ]

    log("Нарезка (без перекодирования)…")
    proc = _run(cmd)
    if proc.returncode != 0:
        raise FfmpegError(
            "ffmpeg завершился с ошибкой при нарезке:\n"
            + proc.stderr.decode("utf-8", "ignore")[-800:]
        )

    parts = sorted(glob.glob(os.path.join(output_dir, f"{base}_part*{ext}")))
    if not parts:
        raise FfmpegError("Нарезка не дала результата — куски не созданы.")

    for p in parts:
        log(f"  ✓ {os.path.basename(p)} — {os.path.getsize(p) / MB:.1f} МБ")
    log(f"Готово: {len(parts)} кусок(ов).")
    return parts


def _fmt_dur(seconds: float) -> str:
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"
