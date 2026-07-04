"""Хранение настроек приложения (JSON в папке пользователя).

Настройки LLM API-ключа хранятся локально в %APPDATA%\\VideoSplitter\\config.json
(на других ОС — в ~/.config/VideoSplitter/config.json).
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field


def _config_dir() -> str:
    """Каталог для хранения настроек, зависящий от ОС."""
    if os.name == "nt":  # Windows
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(
            os.path.expanduser("~"), ".config"
        )
    path = os.path.join(base, "VideoSplitter")
    os.makedirs(path, exist_ok=True)
    return path


CONFIG_PATH = os.path.join(_config_dir(), "config.json")


@dataclass
class AppConfig:
    """Настройки приложения.

    Поля LLM ориентированы на любой OpenAI-совместимый эндпоинт
    транскрибации (audio/transcriptions): официальный OpenAI Whisper,
    локальный whisper.cpp server, Groq, и т. п.
    """

    # --- Нарезка ---
    last_input_dir: str = ""
    last_output_dir: str = ""
    target_size_mb: int = 500  # 300 / 500 / 1000 или произвольный

    # --- LLM / транскрибация ---
    api_base_url: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = "whisper-1"
    language: str = ""  # "" = автоопределение, иначе ISO-код: "ru", "en" ...
    # Максимальная длина одного аудио-фрагмента, отправляемого в API (сек).
    # Ограничивает размер запроса (у OpenAI лимит ~25 МБ на файл).
    audio_chunk_seconds: int = 600

    # --- Прочее ---
    ffmpeg_path: str = ""  # ручной путь к ffmpeg, если не найден в PATH

    extra: dict = field(default_factory=dict)

    @classmethod
    def load(cls) -> "AppConfig":
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            known = {f for f in cls.__dataclass_fields__}
            filtered = {k: v for k, v in data.items() if k in known}
            return cls(**filtered)
        except (FileNotFoundError, json.JSONDecodeError, TypeError):
            return cls()

    def save(self) -> None:
        with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
            json.dump(asdict(self), fh, ensure_ascii=False, indent=2)
