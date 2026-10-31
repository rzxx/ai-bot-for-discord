"""Loopback speech worker. Audio and text are never logged."""
from __future__ import annotations
import argparse
import base64
import hmac
import io
import json
import os
import re
import threading
import sys
import time
import wave
import textwrap
import numpy as np
import sherpa_onnx
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch
from num2words import num2words

VOICES = ("aidar", "baya", "kseniya", "xenia", "eugene")


def normalize_russian(text: str, pronunciations: dict[str, str] | None = None) -> str:
    # Explicit stress marks (+) and ё survive. The model handles Russian homographs.
    text = re.sub(r"([аеёиоуыэюяАЕЁИОУЫЭЮЯ])\u0301", r"+\1", text)
    text = re.sub(r"https?://\S+", "ссылка", text)
    text = re.sub(r"<[^>]*>", " ", text)  # never accept model-generated SSML
    for original, spoken in sorted((pronunciations or {}).items(), key=lambda item: len(item[0]), reverse=True):
        if original:
            text = re.sub(r"(?<!\w)" + re.escape(original) + r"(?!\w)", lambda _: spoken, text, flags=re.I)
    # Stable baseline for integers/decimals; natural case/units should come from the text model.
    def number(match: re.Match) -> str:
        value = match.group().replace(",", ".")
        if len(value) > 16:
            return " ".join(num2words(int(c), lang="ru") for c in value if c.isdigit())
        try:
            if "." in value:
                whole, fraction = value.split(".", 1)
                return num2words(int(whole), lang="ru") + " запятая " + " ".join(num2words(int(c), lang="ru") for c in fraction)
            return num2words(int(value), lang="ru")
        except (ValueError, OverflowError):
            return match.group()
    text = re.sub(r"(?<!\w)-?\d+(?:[.,]\d+)?", number, text)
    text = text.replace("%", " процентов ").replace("₽", " рублей ")
    text = re.sub(r"[`*_#|~]", "", text)
    # Prefer Russian phonetic spellings from the model. Common game terms have explicit overrides.
    return re.sub(r"\s+", " ", text).strip()


def normalize_english(text: str, pronunciations: dict[str, str] | None = None) -> str:
    text = re.sub(r"https?://\S+", "link", text)
    text = re.sub(r"<[^>]*>", " ", text)
    for original, spoken in sorted((pronunciations or {}).items(), key=lambda item: len(item[0]), reverse=True):
        if original:
            text = re.sub(r"(?<!\w)" + re.escape(original) + r"(?!\w)", lambda _: spoken, text, flags=re.I)
    def number(match: re.Match) -> str:
        value = match.group()
        try:
            if len(value) > 16:
                return " ".join(num2words(int(c), lang="en") for c in value if c.isdigit())
            if "." in value:
                whole, fraction = value.split(".", 1)
                return num2words(int(whole), lang="en") + " point " + " ".join(num2words(int(c), lang="en") for c in fraction)
            return num2words(int(value), lang="en")
        except (ValueError, OverflowError):
            return value
    text = re.sub(r"(?<!\w)-?\d+(?:\.\d+)?", number, text)
    text = text.replace("%", " percent ")
    return re.sub(r"\s+", " ", re.sub(r"[`*_#|~]", "", text)).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--language", choices=("en", "ru"), default="ru")
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--vad-model", type=Path, required=True)
    parser.add_argument("--asr-engine", choices=("gigaam", "whisper"), default="gigaam")
    parser.add_argument("--gigaam-dir", type=Path)
    parser.add_argument("--asr-threads", type=int, default=4)
    args = parser.parse_args()
    voices = VOICES if args.language == "ru" else tuple(f"en_{i}" for i in range(118))
    token = os.environ.get("SPEECH_SERVICE_TOKEN", "")
    if not token:
        raise SystemExit("SPEECH_SERVICE_TOKEN is required")
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    model = torch.package.PackageImporter(str(args.model)).load_pickle("tts_models", "model")
    model.to(torch.device("cpu"))
    lock = threading.Lock()
    asr_lock = threading.Lock()
    vad_config = sherpa_onnx.VadModelConfig()
    vad_config.silero_vad.model = str(args.vad_model)
    vad_config.silero_vad.threshold = 0.4
    vad_config.silero_vad.min_speech_duration = 0.15
    vad_config.silero_vad.min_silence_duration = 0.1
    vad_config.sample_rate = 16000
    vad_config.num_threads = 1
    vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=40)
    # Streaming VAD has independent recurrent state per Discord speaker. Batch
    # STT's VAD and recognizer retain their own state/lock on the HTTP threads.
    live_config = sherpa_onnx.VadModelConfig()
    live_config.silero_vad.model = str(args.vad_model)
    live_config.silero_vad.threshold = 0.4
    live_config.silero_vad.min_speech_duration = 0.032
    live_config.silero_vad.min_silence_duration = 0.032
    live_config.sample_rate = 16000
    live_config.num_threads = 1

    def live_vad():
        states = {}
        for line in iter(lambda: sys.stdin.buffer.readline(16385), b""):
            request_id = None
            try:
                if len(line) > 16384:
                    raise ValueError("VAD message too large")
                data = json.loads(line)
                stream_id = data["stream"]
                if not isinstance(stream_id, str) or len(stream_id) > 64:
                    raise ValueError("Invalid stream")
                if data.get("close"):
                    states.pop(stream_id, None)
                    continue
                request_id = data["id"]
                if not isinstance(request_id, int):
                    raise ValueError("Invalid request id")
                pcm = base64.b64decode(data["pcm"], validate=True)
                if not pcm or len(pcm) > 5120 or len(pcm) % 2:
                    raise ValueError("Invalid PCM")
                now = time.monotonic()
                for stale in [key for key, value in states.items() if now - value[3] > 90]:
                    del states[stale]
                state = states.get(stream_id)
                if state is None:
                    if len(states) >= 16:
                        raise ValueError("Too many VAD streams")
                    state = [sherpa_onnx.VadModel.create(live_config), np.empty(0, dtype=np.float32), False, now]
                    states[stream_id] = state
                detector, remainder, previous, _ = state
                if data.get("reset"):
                    detector.reset()
                    remainder = np.empty(0, dtype=np.float32)
                    previous = False
                samples = np.concatenate((remainder, np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768))
                window = detector.window_size()
                flags = []
                used = 0
                while used + window <= len(samples):
                    flags.append(detector.is_speech(samples[used:used + window]))
                    used += window
                # Retain less than one model window, never an audio backlog.
                state[1] = samples[used:].copy()
                if flags:
                    state[2] = flags[-1]
                state[3] = now
                speech = any(flags) if flags else previous
                print("@vad " + json.dumps({"id": request_id, "speech": bool(speech)}), flush=True)
            except Exception:
                if request_id is not None:
                    print("@vad " + json.dumps({"id": request_id, "error": "invalid_vad_request"}), flush=True)

    threading.Thread(target=live_vad, name="live-vad", daemon=True).start()
    recognizer = None
    if args.asr_engine == "gigaam":
        recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(args.gigaam_dir / "encoder.int8.onnx"),
            decoder=str(args.gigaam_dir / "decoder.onnx"),
            joiner=str(args.gigaam_dir / "joiner.onnx"),
            tokens=str(args.gigaam_dir / "tokens.txt"),
            model_type="nemo_transducer", feature_dim=64, sample_rate=16000,
            num_threads=args.asr_threads, decoding_method="greedy_search", provider="cpu",
        )

    def decode_input(body: bytes):
        with wave.open(io.BytesIO(body), "rb") as wav:
            if wav.getnchannels() != 1 or wav.getframerate() != 16000 or wav.getsampwidth() != 2:
                raise ValueError("Expected 16kHz mono PCM16 WAV")
            samples = np.frombuffer(wav.readframes(16000 * 31), dtype="<i2").astype(np.float32) / 32768
        if len(samples) > 16000 * 30:
            raise ValueError("Audio too long")
        vad.reset()
        padded = np.concatenate((samples, np.zeros(3200, dtype=np.float32)))
        window = vad_config.silero_vad.window_size
        for start in range(0, len(padded) - window + 1, window):
            vad.accept_waveform(padded[start:start + window])
        vad.flush()
        speech = not vad.empty()
        vad.reset()
        return samples, speech

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status: int, body: bytes, content_type="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path != "/health":
                self.reply(404, b'{}')
                return
            self.reply(200, json.dumps({"ok": True, "engine": "silero", "model": args.model.stem, "language": args.language, "voices": voices,
                                        "ttsBusy": lock.locked()}).encode())

        def do_POST(self):
            if self.path not in ("/tts", "/stt", "/vad"):
                self.reply(404, b'{}')
                return
            if not hmac.compare_digest(self.headers.get("X-Speech-Token", ""), token):
                self.reply(403, b'{}')
                return
            if self.path in ("/stt", "/vad"):
                size = int(self.headers.get("Content-Length", "0"))
                if size < 44 or size > 1000000:
                    self.reply(413, b'{}')
                    return
                if not asr_lock.acquire(blocking=False):
                    self.reply(429, b'{"error":"busy"}')
                    return
                try:
                    samples, speech = decode_input(self.rfile.read(size))
                    text = ""
                    if speech and self.path == "/stt":
                        if recognizer is None:
                            raise ValueError("ASR is not loaded")
                        stream = recognizer.create_stream()
                        stream.accept_waveform(16000, samples)
                        recognizer.decode_stream(stream)
                        text = stream.result.text
                    self.reply(200, json.dumps({"speech": speech, "text": text}, ensure_ascii=False).encode("utf-8"))
                except (ValueError, wave.Error):
                    self.reply(400, b'{"error":"invalid_audio"}')
                except Exception as error:
                    print(f"STT error: {type(error).__name__}", flush=True)
                    self.reply(500, b'{"error":"recognition_failed"}')
                finally:
                    asr_lock.release()
                return
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > 32000:
                self.reply(413, b'{}')
                return
            if not lock.acquire(blocking=False):
                self.reply(429, b'{"error":"busy"}')
                return
            try:
                data = json.loads(self.rfile.read(size))
                text, speaker = data["text"], data.get("voice", "eugene" if args.language == "ru" else "en_0")
                pronunciations = data.get("pronunciations", {})
                if not isinstance(text, str) or len(text) > 1500 or speaker not in voices:
                    raise ValueError("Invalid text or voice")
                if not isinstance(pronunciations, dict) or len(pronunciations) > 200 or any(not isinstance(k, str) or not isinstance(v, str) or len(k) > 100 or len(v) > 100 for k, v in pronunciations.items()):
                    raise ValueError("Invalid pronunciations")
                text = (normalize_russian if args.language == "ru" else normalize_english)(text, pronunciations)
                if not text:
                    raise ValueError("Empty text")
                with torch.inference_mode():
                    chunks = []
                    # Keep segments below the model's text limit, preserving punctuation/intention.
                    for sentence in textwrap.wrap(text, width=420, break_long_words=True, break_on_hyphens=False):
                        options = {"put_accent": True, "put_yo": True} if args.language == "ru" else {}
                        audio = model.apply_tts(text=sentence.strip(), speaker=speaker, sample_rate=48000, **options)
                        chunks.append(audio.detach().cpu().flatten())
                    if not chunks:
                        raise ValueError("No synthesizable text")
                    pcm = (torch.cat(chunks).clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes()
                output = io.BytesIO()
                with wave.open(output, "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(48000)
                    wav.writeframes(pcm)
                response = (200, output.getvalue(), "audio/wav")
            except (ValueError, KeyError, TypeError, json.JSONDecodeError):
                response = (400, b'{"error":"invalid_request"}', "application/json")
            except Exception as error:
                # Class only: model internals may otherwise echo submitted text.
                print(f"TTS error: {type(error).__name__}", flush=True)
                response = (500, b'{"error":"synthesis_failed"}', "application/json")
            finally:
                lock.release()
            # A completed HTTP response is the client's permission to start its
            # next queued task, so release inference ownership BEFORE replying.
            self.reply(*response)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(json.dumps({"ready": True, "port": args.port, "model": "v5_5_ru"}), flush=True)
    server.serve_forever(poll_interval=0.2)


if __name__ == "__main__":
    main()
