"""Bridge state and token tests; no HTTP server and no helper subprocess."""

from __future__ import annotations

import json
from pathlib import Path

from kara_duet.bridge import Bridge, Job, load_token, token_path


class FakeProcess:
    def __init__(self, lines: tuple[str, ...] = (), code: int | None = None) -> None:
        self.stdout = iter(lines)
        self.code = code
        self.terminated = False

    def poll(self) -> int | None:
        return self.code

    def wait(self) -> int:
        return 0 if self.code is None else self.code

    def terminate(self) -> None:
        self.terminated = True


def test_load_token_prefers_explicit_then_environment_then_file(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("KARA_DUET_TOKEN", raising=False)

    assert load_token("explicit") == "explicit"

    monkeypatch.setenv("KARA_DUET_TOKEN", "from-env")
    assert load_token(None) == "from-env"

    monkeypatch.delenv("KARA_DUET_TOKEN")
    generated = load_token(None)
    assert len(generated) >= 20
    assert token_path().read_text().strip() == generated
    assert load_token(None) == generated


def test_job_snapshot_has_the_fields_the_extension_reads(tmp_path: Path) -> None:
    job = Job("abc", tmp_path)
    snapshot = job.snapshot()

    assert snapshot["jobId"] == "abc"
    assert snapshot["state"] == "running"
    assert snapshot["phase"] == "starting"
    assert snapshot["done"] == 0
    assert snapshot["total"] == 0
    assert snapshot["error"] is None
    assert snapshot["version"] == 0


def test_cancel_active_terminates_and_marks_the_job(tmp_path: Path) -> None:
    bridge = Bridge(tmp_path, tmp_path / "unmixx", tmp_path / "jobs")
    job = Job("abc", tmp_path)
    process = FakeProcess()
    job.process = process  # type: ignore[assignment]
    bridge.jobs["abc"] = job
    bridge.active = "abc"

    bridge.cancel_active("replaced")

    assert process.terminated is True
    assert job.state == "error"
    assert job.error == "replaced"
    assert bridge.active is None


def test_cancel_active_is_a_no_op_without_a_job(tmp_path: Path) -> None:
    bridge = Bridge(tmp_path, tmp_path / "unmixx", tmp_path / "jobs")
    bridge.cancel_active("replaced")
    assert bridge.active is None


def test_reader_ignores_a_replaced_process(tmp_path: Path) -> None:
    bridge = Bridge(tmp_path, tmp_path / "unmixx", tmp_path / "jobs")
    job = Job("abc", tmp_path)
    job.state = "running"
    job.process = FakeProcess()  # type: ignore[assignment]
    old = FakeProcess((json.dumps({"stage": "done"}),))

    bridge._read(job, old)  # type: ignore[arg-type]

    assert job.state == "running"
    assert job.version == 0
    assert job.error is None


def test_reader_finishes_the_process_it_owns(tmp_path: Path) -> None:
    bridge = Bridge(tmp_path, tmp_path / "unmixx", tmp_path / "jobs")
    job = Job("abc", tmp_path)
    process = FakeProcess((json.dumps({"stage": "done"}),))
    job.process = process  # type: ignore[assignment]

    bridge._read(job, process)  # type: ignore[arg-type]

    assert job.state == "done"
    assert job.version == 1
    assert job.error is None
