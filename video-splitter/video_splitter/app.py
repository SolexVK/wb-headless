"""Графический интерфейс (Tkinter) мини-приложения.

Три вкладки:
  • Нарезка       — разрезать длинное видео на куски 300/500/1000 МБ.
  • Транскрибация — распознать речь в выбранных файлах через LLM.
  • Настройки LLM — эндпоинт, ключ, модель, язык.
"""

from __future__ import annotations

import os
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from . import __version__
from .config import AppConfig
from .splitter import split_video
from .transcriber import TranscribeSettings, transcribe_file

VIDEO_TYPES = [
    ("Видео", "*.mp4 *.mkv *.avi *.mov *.wmv *.flv *.webm *.ts *.m4v"),
    ("Все файлы", "*.*"),
]
PRESET_SIZES = (300, 500, 1000)


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.cfg = AppConfig.load()
        self.title(f"Video Splitter + LLM Transcriber v{__version__}")
        self.geometry("760x600")
        self.minsize(680, 520)

        self._log_queue: "queue.Queue[str]" = queue.Queue()
        self._busy = False

        self._build_ui()
        self.after(100, self._drain_log)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=8, pady=(8, 0))

        self._tab_split = ttk.Frame(nb)
        self._tab_transcribe = ttk.Frame(nb)
        self._tab_settings = ttk.Frame(nb)
        nb.add(self._tab_split, text="  Нарезка  ")
        nb.add(self._tab_transcribe, text="  Транскрибация  ")
        nb.add(self._tab_settings, text="  Настройки LLM  ")

        self._build_split_tab(self._tab_split)
        self._build_transcribe_tab(self._tab_transcribe)
        self._build_settings_tab(self._tab_settings)

        # Общий лог + прогресс снизу.
        bottom = ttk.Frame(self)
        bottom.pack(fill="both", expand=False, padx=8, pady=8)
        self._progress = ttk.Progressbar(bottom, mode="indeterminate")
        self._progress.pack(fill="x")
        self._log = tk.Text(bottom, height=10, wrap="word", state="disabled",
                            font=("Consolas", 9))
        self._log.pack(fill="both", expand=True, pady=(6, 0))

    def _build_split_tab(self, parent: ttk.Frame) -> None:
        pad = {"padx": 8, "pady": 4}

        ttk.Label(parent, text="Исходное видео:").grid(row=0, column=0, sticky="w", **pad)
        self.var_input = tk.StringVar()
        ttk.Entry(parent, textvariable=self.var_input).grid(row=0, column=1, sticky="we", **pad)
        ttk.Button(parent, text="Обзор…", command=self._pick_input).grid(row=0, column=2, **pad)

        ttk.Label(parent, text="Папка для кусков:").grid(row=1, column=0, sticky="w", **pad)
        self.var_output = tk.StringVar(value=self.cfg.last_output_dir)
        ttk.Entry(parent, textvariable=self.var_output).grid(row=1, column=1, sticky="we", **pad)
        ttk.Button(parent, text="Обзор…", command=self._pick_output).grid(row=1, column=2, **pad)

        size_frame = ttk.LabelFrame(parent, text="Размер куска")
        size_frame.grid(row=2, column=0, columnspan=3, sticky="we", **pad)
        self.var_size = tk.IntVar(value=self.cfg.target_size_mb)
        for i, mb in enumerate(PRESET_SIZES):
            ttk.Radiobutton(
                size_frame, text=f"{mb} МБ", value=mb, variable=self.var_size,
                command=self._sync_custom_size,
            ).grid(row=0, column=i, padx=10, pady=6, sticky="w")
        ttk.Label(size_frame, text="Свой размер, МБ:").grid(row=0, column=3, padx=(20, 4))
        self.var_custom_size = tk.StringVar(
            value="" if self.cfg.target_size_mb in PRESET_SIZES else str(self.cfg.target_size_mb)
        )
        ttk.Entry(size_frame, width=8, textvariable=self.var_custom_size).grid(row=0, column=4)

        self.btn_split = ttk.Button(parent, text="Разрезать видео", command=self._do_split)
        self.btn_split.grid(row=3, column=0, columnspan=3, pady=10)

        parent.columnconfigure(1, weight=1)

    def _build_transcribe_tab(self, parent: ttk.Frame) -> None:
        pad = {"padx": 8, "pady": 4}
        ttk.Label(
            parent,
            text="Выберите один или несколько файлов (например, куски после нарезки).",
        ).grid(row=0, column=0, columnspan=3, sticky="w", **pad)

        self.lst_files = tk.Listbox(parent, selectmode="extended", height=10)
        self.lst_files.grid(row=1, column=0, columnspan=2, sticky="nsew", **pad)

        btns = ttk.Frame(parent)
        btns.grid(row=1, column=2, sticky="ns", **pad)
        ttk.Button(btns, text="Добавить…", command=self._add_transcribe_files).pack(fill="x", pady=2)
        ttk.Button(btns, text="Убрать", command=self._remove_transcribe_files).pack(fill="x", pady=2)
        ttk.Button(btns, text="Очистить", command=lambda: self.lst_files.delete(0, "end")).pack(fill="x", pady=2)

        self.btn_transcribe = ttk.Button(
            parent, text="Транскрибировать", command=self._do_transcribe
        )
        self.btn_transcribe.grid(row=2, column=0, columnspan=3, pady=10)

        ttk.Label(
            parent,
            text="Результат (.txt и .srt) сохраняется рядом с исходным файлом.",
            foreground="#666",
        ).grid(row=3, column=0, columnspan=3, sticky="w", **pad)

        parent.columnconfigure(0, weight=1)
        parent.rowconfigure(1, weight=1)

    def _build_settings_tab(self, parent: ttk.Frame) -> None:
        pad = {"padx": 8, "pady": 5}
        rows = [
            ("Эндпоинт API (base URL):", "api_base_url", False,
             "Напр. https://api.openai.com/v1 или адрес локального сервера."),
            ("API-ключ:", "api_key", True, "Хранится локально на этом компьютере."),
            ("Модель:", "model", False, "Напр. whisper-1, gpt-4o-transcribe."),
            ("Язык (ISO, пусто = авто):", "language", False, "ru, en, … или пусто."),
        ]
        self._settings_vars: dict[str, tk.StringVar] = {}
        for r, (label, key, secret, hint) in enumerate(rows):
            ttk.Label(parent, text=label).grid(row=r * 2, column=0, sticky="w", **pad)
            var = tk.StringVar(value=str(getattr(self.cfg, key)))
            self._settings_vars[key] = var
            ttk.Entry(
                parent, textvariable=var, show="•" if secret else "", width=52
            ).grid(row=r * 2, column=1, sticky="we", **pad)
            ttk.Label(parent, text=hint, foreground="#888").grid(
                row=r * 2 + 1, column=1, sticky="w", padx=8
            )

        ttk.Label(parent, text="Путь к ffmpeg (если не в PATH):").grid(
            row=99, column=0, sticky="w", **pad
        )
        self.var_ffmpeg = tk.StringVar(value=self.cfg.ffmpeg_path)
        ttk.Entry(parent, textvariable=self.var_ffmpeg, width=52).grid(
            row=99, column=1, sticky="we", **pad
        )

        ttk.Button(parent, text="Сохранить настройки", command=self._save_settings).grid(
            row=100, column=0, columnspan=2, pady=12
        )
        parent.columnconfigure(1, weight=1)

    # -------------------------------------------------------------- helpers
    def _sync_custom_size(self) -> None:
        self.var_custom_size.set("")

    def _current_target_size(self) -> int:
        custom = self.var_custom_size.get().strip()
        if custom:
            if not custom.isdigit() or int(custom) <= 0:
                raise ValueError("Свой размер должен быть положительным числом МБ.")
            return int(custom)
        return int(self.var_size.get())

    def _pick_input(self) -> None:
        path = filedialog.askopenfilename(
            title="Выберите видео", filetypes=VIDEO_TYPES,
            initialdir=self.cfg.last_input_dir or None,
        )
        if path:
            self.var_input.set(path)
            if not self.var_output.get():
                self.var_output.set(os.path.dirname(path))

    def _pick_output(self) -> None:
        path = filedialog.askdirectory(
            title="Папка для кусков", initialdir=self.var_output.get() or None
        )
        if path:
            self.var_output.set(path)

    def _add_transcribe_files(self) -> None:
        paths = filedialog.askopenfilenames(title="Файлы для транскрибации", filetypes=VIDEO_TYPES)
        existing = set(self.lst_files.get(0, "end"))
        for p in paths:
            if p not in existing:
                self.lst_files.insert("end", p)

    def _remove_transcribe_files(self) -> None:
        for i in reversed(self.lst_files.curselection()):
            self.lst_files.delete(i)

    def log(self, msg: str) -> None:
        """Потокобезопасный вывод в лог (через очередь)."""
        self._log_queue.put(msg)

    def _drain_log(self) -> None:
        try:
            while True:
                msg = self._log_queue.get_nowait()
                self._log.configure(state="normal")
                self._log.insert("end", msg + "\n")
                self._log.see("end")
                self._log.configure(state="disabled")
        except queue.Empty:
            pass
        self.after(100, self._drain_log)

    def _set_busy(self, busy: bool) -> None:
        self._busy = busy
        state = "disabled" if busy else "normal"
        self.btn_split.configure(state=state)
        self.btn_transcribe.configure(state=state)
        if busy:
            self._progress.start(12)
        else:
            self._progress.stop()

    def _run_worker(self, fn) -> None:
        """Запускает fn в фоне, блокируя кнопки на время работы."""
        if self._busy:
            return
        self._set_busy(True)

        def wrapper() -> None:
            try:
                fn()
            except Exception as exc:  # noqa: BLE001 - показываем пользователю
                self.log(f"ОШИБКА: {exc}")
                self.after(0, lambda: messagebox.showerror("Ошибка", str(exc)))
            finally:
                self.after(0, lambda: self._set_busy(False))

        threading.Thread(target=wrapper, daemon=True).start()

    # --------------------------------------------------------------- actions
    def _do_split(self) -> None:
        input_path = self.var_input.get().strip()
        output_dir = self.var_output.get().strip() or os.path.dirname(input_path)
        if not input_path:
            messagebox.showwarning("Нет файла", "Выберите исходное видео.")
            return
        try:
            size_mb = self._current_target_size()
        except ValueError as exc:
            messagebox.showwarning("Размер", str(exc))
            return

        # Сохраняем выбор пользователя.
        self.cfg.last_input_dir = os.path.dirname(input_path)
        self.cfg.last_output_dir = output_dir
        self.cfg.target_size_mb = size_mb
        self.cfg.ffmpeg_path = self.var_ffmpeg.get().strip()
        self.cfg.save()

        def job() -> None:
            parts = split_video(
                input_path, output_dir, size_mb,
                ffmpeg_override=self.cfg.ffmpeg_path, progress=self.log,
            )
            self.after(
                0,
                lambda: messagebox.showinfo(
                    "Готово", f"Создано кусков: {len(parts)}\nПапка: {output_dir}"
                ),
            )

        self._run_worker(job)

    def _do_transcribe(self) -> None:
        files = list(self.lst_files.get(0, "end"))
        if not files:
            messagebox.showwarning("Нет файлов", "Добавьте файлы для транскрибации.")
            return
        self._collect_settings()
        if not self.cfg.api_key:
            messagebox.showwarning("Нет ключа", "Укажите API-ключ во вкладке «Настройки LLM».")
            return
        self.cfg.save()

        settings = TranscribeSettings(
            api_base_url=self.cfg.api_base_url,
            api_key=self.cfg.api_key,
            model=self.cfg.model,
            language=self.cfg.language,
            audio_chunk_seconds=self.cfg.audio_chunk_seconds,
            ffmpeg_override=self.cfg.ffmpeg_path,
        )

        def job() -> None:
            done = 0
            for f in files:
                self.log(f"── {os.path.basename(f)} ──")
                transcribe_file(f, settings, progress=self.log)
                done += 1
            self.after(
                0,
                lambda: messagebox.showinfo("Готово", f"Транскрибировано файлов: {done}"),
            )

        self._run_worker(job)

    def _collect_settings(self) -> None:
        for key, var in self._settings_vars.items():
            setattr(self.cfg, key, var.get().strip())
        self.cfg.ffmpeg_path = self.var_ffmpeg.get().strip()

    def _save_settings(self) -> None:
        self._collect_settings()
        self.cfg.save()
        messagebox.showinfo("Сохранено", "Настройки сохранены.")

    def _on_close(self) -> None:
        if self._busy and not messagebox.askyesno(
            "Выход", "Идёт обработка. Точно выйти?"
        ):
            return
        try:
            self._collect_settings()
            self.cfg.save()
        except Exception:  # noqa: BLE001
            pass
        self.destroy()


def main() -> None:
    App().mainloop()


if __name__ == "__main__":
    main()
