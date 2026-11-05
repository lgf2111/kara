"""Command line entry point for the native duet helper."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .config import DEFAULT_CHUNK_SECONDS, DEFAULT_OVERLAP_SECONDS
from .pipeline import run


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Split a vocal stem into two calibrated voices.")
    parser.add_argument("--input", type=Path, help="vocal WAV; omitted with --reuse")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument(
        "--unmixx",
        type=Path,
        default=Path(__file__).resolve().parent.parent / ".vendor/unmixx",
    )
    parser.add_argument("--device", default="auto", choices=["auto", "mps", "cuda", "cpu"])
    parser.add_argument("--chunk-seconds", type=float, default=DEFAULT_CHUNK_SECONDS)
    parser.add_argument("--overlap-seconds", type=float, default=DEFAULT_OVERLAP_SECONDS)
    parser.add_argument("--anchors", default=None, help="JSON list or path to a JSON list")
    parser.add_argument("--reuse", action="store_true", help="re-render from saved chunks")
    args = parser.parse_args(argv)

    if args.reuse:
        if not args.output_dir.is_dir():
            parser.error(f"no saved analysis at {args.output_dir}")
    else:
        if args.input is None or not args.input.is_file():
            parser.error("--input is required unless --reuse is used")
        if not (args.unmixx / "ckpt/best.ckpt").is_file():
            parser.error(f"UNMIXX checkpoint not found under {args.unmixx}; run setup.sh first")

    try:
        run(
            args.input or Path(""),
            args.output_dir,
            args.unmixx,
            args.device,
            args.chunk_seconds,
            args.overlap_seconds,
            args.anchors,
            args.reuse,
        )
    except Exception as cause:  # noqa: BLE001 - the CLI reports the reason
        print(json.dumps({"stage": "error", "reason": str(cause)}), flush=True)
        raise SystemExit(1) from cause


if __name__ == "__main__":
    main()
