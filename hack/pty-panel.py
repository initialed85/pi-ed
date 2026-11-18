#!/usr/bin/env python3
"""Press keys in a real `pi` running in a real pty, and report what the screen did.

Why this exists: a TUI extension's two failure modes - "the terminal never sent that key" and "the overlay mounted
somewhere off the visible rows" - are invisible to a test double. The doubles in `test/harness.ts` model Pi's
behaviour, and they pass; this runs the actual binary under `pty.fork()`, types into it, presses a key, and greps the
resulting screen. No model call is made, so it costs nothing but a few seconds of startup.

    hack/pty-panel.py shift+down                 # empty session, then the key
    hack/pty-panel.py --rows 30 --cols 110 shift+down "/todo restart the pods" "/todo ship it"
    hack/pty-panel.py shift+up "/goal ship it"

Keys are spelled the way `@earendil-works/pi-tui` spells them and are translated here to the bytes a terminal would
send for them, which is the part worth keeping: `shift+down` is `ESC [ 1 ; 2 B`, and if a terminal eats shift+arrows
for its own scrollback this script will show a screen that never changes.

Slash commands are typed in two writes (text, then `CR`) because `LF` is a newline in Pi's editor, not a submit -
that mistake cost one false "the command does not run" reading.
"""
import argparse, fcntl, json, os, pty, re, select, struct, sys, termios, time

KEY_BYTES = {
    "shift+down": "\x1b[1;2B",
    "shift+up": "\x1b[1;2A",
    "shift+left": "\x1b[1;2D",
    "shift+right": "\x1b[1;2C",
    "ctrl+shift+down": "\x1b[1;6B",
    "enter": "\r",
    "escape": "\x1b",
}
MARKERS = ("Plan:", "— this session", "◆ goal", "no steps yet", "t1", "t2", "1 open", "2 open", "3 open")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=30)
    ap.add_argument("--cols", type=int, default=110)
    ap.add_argument("--session-id", default="01a1d000-0000-4000-8000-000000000009")
    ap.add_argument("--extension", default=os.path.join(os.path.dirname(__file__), "..", "extensions", "plan.ts"))
    ap.add_argument("--cwd", default=None)
    ap.add_argument("--startup", type=float, default=9.0)
    ap.add_argument("key", nargs="?", default="shift+down")
    ap.add_argument("commands", nargs="*")
    args = ap.parse_args()

    key = KEY_BYTES.get(args.key)
    if key is None:
        print(f"unknown key {args.key!r}; known: {', '.join(KEY_BYTES)}", file=sys.stderr)
        return 2
    workdir = args.cwd or f"/tmp/pty-panel-{abs(hash((args.session_id, tuple(args.commands)))) % 10**8}"
    os.system(f"rm -rf {workdir} && mkdir -p {workdir}")

    env = dict(os.environ, TERM="xterm-256color", LINES=str(args.rows), COLUMNS=str(args.cols))
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workdir)
        os.environ.clear()
        os.environ.update(env)
        os.execvp("pi", ["pi", "-ne", "-e", os.path.abspath(args.extension), "--session-id", args.session_id,
                         "--provider", "rooter", "--model", "auto"])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))
    screen = bytearray()

    def pump(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if not ready:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            screen.extend(chunk)

    def text() -> str:
        raw = bytes(screen).decode("utf-8", "replace")
        return re.sub(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]", "", raw)

    pump(args.startup)
    for command in args.commands:
        screen.clear()
        os.write(fd, command.encode())
        pump(2)
        os.write(fd, b"\r")
        pump(3)
        print(f"[typed {command!r}] present={[m for m in MARKERS if m in text()]}")

    screen.clear()
    os.write(fd, key.encode())
    pump(4)
    after = text()
    present = [m for m in MARKERS if m in after]
    print(f"[pressed {args.key}] present={present}")
    print(f"=== screen tail ({workdir}) ===")
    print(after[-1400:])
    try:
        os.kill(pid, 15)
    except ProcessLookupError:
        pass
    os.close(fd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
