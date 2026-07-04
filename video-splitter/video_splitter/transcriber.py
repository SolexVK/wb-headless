"""Транскрибация видео/аудио через подключаемый LLM (OpenAI-совместимый Whisper API).

Схема работы:
  1. Извлекаем из видео компактную аудиодорожку (mono, 16 кГц, mp3 64 кбит/с).
  2. Режем аудио на фрагменты по N секунд, чтобы каждый запрос укладывался
     в лимит API (у OpenAI ~25 МБ на файл).
  3. Каждый фрагмент отправляем в эндпоинт /audio/transcriptions.
  4. Склеиваем текст и субтитры (SRT) со сквозными таймкодами.

Работает с любым OpenAI-совместимым сервером: официальный OpenAI, Groq,
локальный whisper.cpp/faster-whisper server и т. п.
"""

from __future__ import annotations

import glob
import json
import os
import tempfile
from dataclasses import dataclass
from typing import Callable

from .ffmpeg_utils import FfmpegError, _run, probe, resolve_tools

try:
    import requests
except ImportError:  # pragma: no cover - зависимость ставится из requirements.txt
    requests = None  # type: ignore

ProgressCb = Callable[[str], None]


@dataclass
class TranscribeSettings:
    api_base_url: str
    api_key: str
    model: str = "whisper-1"
    language: str = ""            # "" = автоопределение
    audio_chunk_seconds: int = 600
    ffmpeg_override: str = ""


def _extract_audio(src: str, dst: str, ffmpeg: str, log: ProgressCb) -> None:
    """Извлекает сжатое моно-аудио, пригодное для распознавания речи."""
    cmd = [
        ffmpeg, "-hide_banner", "-y",
        "-i", src,
        "-vn", "-ac", "1", "-ar", "16000",
        "-c:a", "libmp3lame", "-b:a", "64k",
        dst,
    ]
    log(f"Извлечение аудио из {os.path.basename(src)}…")
    proc = _run(cmd)
    if proc.returncode != 0:
        raise FfmpegError(
            "Не удалось извлечь аудио:\n" + proc.stderr.decode("utf-8", "ignore")[-500:]
        )


def _segment_audio(audio: str, out_dir: str, chunk_seconds: int, ffmpeg: str) -> list[str]:
    """Режет аудио на фрагменты фиксированной длины (для лимитов API)."""
    pattern = os.path.join(out_dir, "chunk_%04d.mp3")
    cmd = [
        ffmpeg, "-hide_banner", "-y",
        "-i", audio,
        "-f", "segment",
        "-segment_time", str(chunk_seconds),
        "-c", "copy",
        pattern,
    ]
    proc = _run(cmd)
    if proc.returncode != 0:
        raise FfmpegError(
            "Не удалось разбить аудио на фрагменты:\n"
            + proc.stderr.decode("utf-8", "ignore")[-500:]
        )
    return sorted(glob.glob(os.path.join(out_dir, "chunk_*.mp3")))


def _transcribe_chunk(
    path: str, settings: TranscribeSettings, timeout: int = 600
) -> dict:
    """Отправляет один аудиофрагмент в API, возвращает разобранный JSON-ответ."""
    if requests is None:
        raise RuntimeError(
            "Не установлен пакет 'requests'. Выполните: pip install requests"
        )
    url = settings.api_base_url.rstrip("/") + "/audio/transcriptions"
    headers = {"Authorization": f"Bearer {settings.api_key}"}
    data = {
        "model": settings.model,
        # verbose_json даёт сегменты с таймкодами — нужны для SRT.
        "response_format": "verbose_json",
    }
    if settings.language:
        data["language"] = settings.language

    with open(path, "rb") as fh:
        files = {"file": (os.path.basename(path), fh, "audio/mpeg")}
        resp = requests.post(url, headers=headers, data=data, files=files, timeout=timeout)

    if resp.status_code != 200:
        raise RuntimeError(
            f"API вернул {resp.status_code}: {resp.text[:400]}"
        )
    try:
        return resp.json()
    except json.JSONDecodeError:
        # Некоторые серверы при response_format=text отдают чистый текст.
        return {"text": resp.text, "segments": []}


def _srt_time(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_outputs(chunk_results: list[tuple[float, dict]]) -> tuple[str, str]:
    """Собирает (полный_текст, srt) из ответов по фрагментам.

    chunk_results: список (offset_seconds, api_json). offset — смещение фрагмента
    от начала записи, нужен для сквозных таймкодов.
    """
    text_parts: list[str] = []
    srt_lines: list[str] = []
    idx = 1
    for offset, result in chunk_results:
        text = (result.get("text") or "").strip()
        if text:
            text_parts.append(text)
        for seg in result.get("segments") or []:
            start = float(seg.get("start", 0.0)) + offset
            end = float(seg.get("end", 0.0)) + offset
            seg_text = (seg.get("text") or "").strip()
            if not seg_text:
                continue
            srt_lines.append(str(idx))
            srt_lines.append(f"{_srt_time(start)} --> {_srt_time(end)}")
            srt_lines.append(seg_text)
            srt_lines.append("")
            idx += 1
    return "\n".join(text_parts).strip(), "\n".join(srt_lines).strip()


def transcribe_file(
    input_path: str,
    settings: TranscribeSettings,
    progress: ProgressCb | None = None,
) -> tuple[str, str]:
    """Полный цикл транскрибации одного файла. Возвращает (txt_path, srt_path)."""
    log = progress or (lambda _m: None)
    if not settings.api_key:
        raise RuntimeError("Не задан API-ключ LLM в настройках.")
    ffmpeg, ffprobe = resolve_tools(settings.ffmpeg_override)

    info = probe(input_path, ffprobe)
    if not info.has_audio:
        raise FfmpegError("В файле нет аудиодорожки — транскрибировать нечего.")

    with tempfile.TemporaryDirectory(prefix="vsplit_tr_") as tmp:
        audio = os.path.join(tmp, "audio.mp3")
        _extract_audio(input_path, audio, ffmpeg, log)

        chunks = _segment_audio(audio, tmp, settings.audio_chunk_seconds, ffmpeg)
        log(f"Фрагментов для распознавания: {len(chunks)}")

        results: list[tuple[float, dict]] = []
        for i, chunk in enumerate(chunks):
            offset = i * settings.audio_chunk_seconds
            log(f"Распознавание фрагмента {i + 1}/{len(chunks)}…")
            results.append((offset, _transcribe_chunk(chunk, settings)))

    full_text, srt = build_outputs(results)

    base = os.path.splitext(input_path)[0]
    txt_path = base + ".txt"
    srt_path = base + ".srt"
    with open(txt_path, "w", encoding="utf-8") as fh:
        fh.write(full_text + "\n")
    if srt.strip():
        with open(srt_path, "w", encoding="utf-8") as fh:
            fh.write(srt + "\n")
    else:
        srt_path = ""

    log(f"Сохранено: {os.path.basename(txt_path)}"
        + (f", {os.path.basename(srt_path)}" if srt_path else ""))
    return txt_path, srt_path
