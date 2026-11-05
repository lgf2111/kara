"""Local bridge between the Kara extension and the native duet helper.

The extension cannot run PyTorch, and it should not hand a song to a cloud
service. This process owns one helper job at a time, reports progress, and
serves the two rendered WAVs. It binds to loopback only and requires a token
generated on first run.

    python bridge.py --port 8765

The token is printed once and stored in ~/.kara-duet/token. Paste it into the
extension's popup under "Duet helper".
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

VERSION = 1
MAX_BODY_BYTES = 120 * 1024 * 1024
TOKEN_HEADER = "X-Kara-Token"
JOB_TTL_SECONDS = 24 * 60 * 60


def token_path() -> Path:
    return Path.home() / ".kara-duet" / "token"


def load_token(explicit: str | None) -> str:
    if explicit:
        return explicit
    from_env = os.environ.get("KARA_DUET_TOKEN")
    if from_env:
        return from_env
    path = token_path()
    if path.is_file():
        value = path.read_text().strip()
        if value:
            return value
    value = secrets.token_urlsafe(24)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value + "\n")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return value


class Job:
    def __init__(self, job_id: str, directory: Path) -> None:
        self.id = job_id
        self.directory = directory
        self.state = "running"
        self.phase = "starting"
        self.done = 0
        self.total = 0
        self.error: str | None = None
        self.started = time.monotonic()
        self.process: subprocess.Popen[str] | None = None
        self.version = 0
        self.lock = threading.Lock()

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "jobId": self.id,
                "state": self.state,
                "phase": self.phase,
                "done": self.done,
                "total": self.total,
                "elapsedSeconds": round(time.monotonic() - self.started, 1),
                "error": self.error,
                "version": self.version,
            }


class Bridge:
    def __init__(self, helper_dir: Path, unmixx: Path, jobs_dir: Path) -> None:
        self.helper_dir = helper_dir
        self.helper = helper_dir / "helper.py"
        self.unmixx = unmixx
        self.jobs_dir = jobs_dir
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.active: str | None = None
        self.token = ""

    def cleanup(self) -> None:
        cutoff = time.time() - JOB_TTL_SECONDS
        if not self.jobs_dir.is_dir():
            return
        for entry in self.jobs_dir.iterdir():
            try:
                if entry.is_dir() and entry.stat().st_mtime < cutoff:
                    shutil.rmtree(entry, ignore_errors=True)
            except OSError:
                pass

    def _read(self, job: Job, process: subprocess.Popen[str]) -> None:
        assert process.stdout is not None
        for line in process.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            stage = message.get("stage")
            with job.lock:
                if stage in ("loading", "chunk"):
                    job.phase = "separating"
                    job.done = int(message.get("done", job.done))
                    job.total = int(message.get("total", job.total))
                elif stage in ("map", "map-window", "map-cached"):
                    job.phase = "mapping"
                    job.done = int(message.get("done", 0))
                    job.total = int(message.get("total", 1))
                elif stage == "done":
                    job.phase = "done"
                    job.state = "done"
                    job.done = 1
                    job.total = 1
                    job.version += 1
                elif stage == "error":
                    job.error = str(message.get("reason", "the helper stopped"))
        code = process.wait()
        with job.lock:
            if code != 0 and job.state != "done":
                job.state = "error"
                job.error = job.error or f"the helper exited with code {code}"
            elif job.state != "done":
                job.state = "error"
                job.error = job.error or "the helper did not produce a result"
        with self.lock:
            if self.active == job.id:
                self.active = None

    def _start_process(self, job: Job, command: list[str], phase: str) -> bool:
        with self.lock:
            if self.active is not None and self.active != job.id:
                return False
            self.active = job.id
        with job.lock:
            job.state = "running"
            job.phase = phase
            job.error = None
            job.done = 0
            job.total = 0
        try:
            process = subprocess.Popen(
                command,
                cwd=str(self.helper_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except OSError as cause:
            with job.lock:
                job.state = "error"
                job.error = str(cause)
            with self.lock:
                self.active = None
            return False
        job.process = process
        thread = threading.Thread(target=self._read, args=(job, process), daemon=True)
        thread.start()
        return True

    def cancel_active(self, reason: str) -> None:
        with self.lock:
            active = self.active
            self.active = None
        if active is None:
            return
        job = self.find(active)
        if job is not None and job.process is not None and job.process.poll() is None:
            job.process.terminate()
            with job.lock:
                job.state = "error"
                job.error = reason

    def start(self, wav_bytes: bytes) -> Job:
        # One song at a time, newest wins: a new session must not be blocked
        # by a job left behind when the previous tab stopped.
        self.cancel_active("replaced by a newer song")
        job_id = uuid.uuid4().hex[:12]
        directory = self.jobs_dir / job_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "input.wav").write_bytes(wav_bytes)
        job = Job(job_id, directory)
        with self.lock:
            self.jobs[job_id] = job
        command = [
            sys.executable,
            str(self.helper),
            "--input",
            str(directory / "input.wav"),
            "--output-dir",
            str(directory),
            "--unmixx",
            str(self.unmixx),
            "--device",
            "auto",
        ]
        if not self._start_process(job, command, "starting"):
            raise RuntimeError("the helper is busy with another song")
        return job

    def anchor(self, job: Job, voice: int, start: float, end: float) -> None:
        if end - start < 1.0:
            raise ValueError("choose at least one second of a solo line")
        map_path = job.directory / "map.json"
        if not map_path.is_file():
            raise RuntimeError("the voice map is not ready yet")
        try:
            map_data = json.loads(map_path.read_text())
        except json.JSONDecodeError as cause:
            raise RuntimeError("the voice map is unreadable") from cause
        middle = (start + end) / 2
        segment = next(
            (
                item
                for item in map_data.get("segments", [])
                if float(item.get("start", -1)) <= middle < float(item.get("end", -1))
            ),
            None,
        )
        if segment is None or segment.get("kind") != "solo":
            raise ValueError("choose a moment where only one singer is singing")
        anchors_path = job.directory / "anchors.json"
        anchors = []
        if anchors_path.is_file():
            try:
                value = json.loads(anchors_path.read_text())
                if isinstance(value, list):
                    anchors = value
            except json.JSONDecodeError:
                pass
        anchors.append({"voice": voice, "start": start, "end": end})
        anchors_path.write_text(json.dumps(anchors))
        command = [
            sys.executable,
            str(self.helper),
            "--reuse",
            "--output-dir",
            str(job.directory),
            "--anchors",
            str(anchors_path),
            "--unmixx",
            str(self.unmixx),
        ]
        if not self._start_process(job, command, "calibrating"):
            raise RuntimeError("the helper is busy")

    def find(self, job_id: str) -> Job | None:
        with self.lock:
            return self.jobs.get(job_id)


class Handler(BaseHTTPRequestHandler):
    server: "BridgeServer"

    def log_message(self, *_args) -> None:  # noqa: D401 - quiet by design
        return

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", f"Content-Type, {TOKEN_HEADER}")
        self.send_header("Access-Control-Max-Age", "600")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        if not path.is_file():
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        size = path.stat().st_size
        self.send_response(HTTPStatus.OK)
        self._cors()
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with path.open("rb") as handle:
            shutil.copyfileobj(handle, self.wfile)

    def _authorised(self) -> bool:
        return secrets.compare_digest(self.headers.get(TOKEN_HEADER, ""), self.server.bridge.token)

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("the upload is empty or too large")
        return self.rfile.read(length)

    def do_OPTIONS(self) -> None:  # noqa: N802 - http.server API
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        path = urlparse(self.path).path
        if path == "/v1/health":
            busy = self.server.bridge.active is not None
            self._json(HTTPStatus.OK, {"ok": True, "version": VERSION, "busy": busy})
            return
        if not self._authorised():
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "missing or wrong token"})
            return
        parts = [part for part in path.split("/") if part]
        if len(parts) >= 3 and parts[0] == "v1" and parts[1] == "jobs":
            job = self.server.bridge.find(parts[2])
            if job is None:
                self._json(HTTPStatus.NOT_FOUND, {"error": "no such job"})
                return
            if len(parts) == 3:
                self._json(HTTPStatus.OK, job.snapshot())
                return
            if parts[3] == "map.json":
                self._file(job.directory / "map.json")
                return
            if parts[3] in ("voice1.wav", "voice2.wav"):
                self._file(job.directory / parts[3])
                return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        path = urlparse(self.path).path
        if not self._authorised():
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "missing or wrong token"})
            return
        if path == "/v1/jobs":
            try:
                body = self._body()
            except ValueError as cause:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(cause)})
                return
            try:
                job = self.server.bridge.start(body)
            except RuntimeError as cause:
                self._json(HTTPStatus.CONFLICT, {"error": str(cause)})
                return
            self._json(HTTPStatus.ACCEPTED, {"jobId": job.id})
            return
        parts = [part for part in path.split("/") if part]
        if len(parts) >= 4 and parts[0] == "v1" and parts[1] == "jobs" and parts[3] == "cancel":
            job = self.server.bridge.find(parts[2])
            if job is None:
                self._json(HTTPStatus.NOT_FOUND, {"error": "no such job"})
                return
            process = job.process
            if process is not None and process.poll() is None:
                process.terminate()
                with job.lock:
                    job.state = "error"
                    job.error = "cancelled"
            self._json(HTTPStatus.ACCEPTED, job.snapshot())
            return
        if len(parts) >= 4 and parts[0] == "v1" and parts[1] == "jobs" and parts[3] == "anchors":
            job = self.server.bridge.find(parts[2])
            if job is None:
                self._json(HTTPStatus.NOT_FOUND, {"error": "no such job"})
                return
            try:
                body = self._body()
                payload = json.loads(body)
                voice = int(payload.get("voice", 0))
                start = float(payload.get("start", -1))
                end = float(payload.get("end", -1))
                if voice not in (1, 2) or start < 0 or end <= start:
                    raise ValueError("voice and a positive time range are required")
                self.server.bridge.anchor(job, voice, start, end)
            except (ValueError, json.JSONDecodeError, RuntimeError) as cause:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(cause)})
                return
            self._json(HTTPStatus.ACCEPTED, job.snapshot())
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})


class BridgeServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], bridge: Bridge) -> None:
        super().__init__(address, Handler)
        self.bridge = bridge


def main() -> None:
    parser = argparse.ArgumentParser(description="Local bridge for the Kara duet helper.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--unmixx", type=Path, default=Path(__file__).parent / ".vendor/unmixx")
    parser.add_argument("--token", default=None)
    parser.add_argument("--jobs-dir", type=Path, default=Path.home() / ".kara-duet" / "jobs")
    args = parser.parse_args()

    helper_dir = Path(__file__).resolve().parent
    if not (args.unmixx / "ckpt/best.ckpt").is_file():
        parser.error(f"UNMIXX checkpoint not found under {args.unmixx}; run setup.sh first")
    args.jobs_dir.mkdir(parents=True, exist_ok=True)
    bridge = Bridge(helper_dir, args.unmixx.resolve(), args.jobs_dir)
    bridge.token = load_token(args.token)
    bridge.cleanup()
    server = BridgeServer((args.host, args.port), bridge)
    print(f"Kara duet bridge on http://{args.host}:{args.port}", flush=True)
    print(f"token: {bridge.token}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
