#!/usr/bin/env python3
"""Local development service lifecycle; only verified Gamja worktree processes may be stopped."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = ROOT / "scripts" / ".state"
STATE_FILE = STATE_DIR / "service.json"
KINDS = ("backend", "frontend")
BACKEND_UV = re.compile(r"^(?:\S*/)?uv\s+run\s+uvicorn\s+app\.main:app(?:\s|$)")
BACKEND_PYTHON = re.compile(r"^(?:\S*/)?(?:python(?:\d+(?:\.\d+)?)?|Python)\s+(?:-m\s+uvicorn|\S*/uvicorn)\s+app\.main:app(?:\s|$)")
FRONTEND_NPM = re.compile(r"^(?:\S*/)?npm\s+run\s+dev(?:\s|$)")
FRONTEND_NODE_NPM = re.compile(r"^(?:\S*/)?node\s+\S*/npm-cli\.js\s+run\s+dev(?:\s|$)")
FRONTEND_NEXT = re.compile(r"^(?:\S*/)?(?:node\s+\S*/)?next\s+dev(?:\s|$)")


class ServiceError(Exception):
    pass


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=False)


def process(pid: int) -> dict[str, str] | None:
    if pid <= 0:
        return None
    parent = run("ps", "-p", str(pid), "-o", "ppid=")
    started = run("ps", "-p", str(pid), "-o", "lstart=")
    command = run("ps", "-p", str(pid), "-o", "command=")
    if parent.returncode or started.returncode or command.returncode:
        return None
    cwd = run("lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn")
    paths = [line[1:] for line in cwd.stdout.splitlines() if line.startswith("n/")]
    executable = run("lsof", "-a", "-p", str(pid), "-d", "txt", "-Fn")
    binaries = [line[1:] for line in executable.stdout.splitlines() if line.startswith("n/")]
    if not paths or not binaries:
        return None  # Invisible cwd/executable means ownership cannot be proved.
    return {
        "pid": str(pid), "ppid": parent.stdout.strip(),
        "started": started.stdout.strip(), "command": command.stdout.strip(),
        "cwd": str(Path(paths[0]).resolve()), "exe": str(Path(binaries[0]).resolve()),
    }


def trusted_executable(info: dict[str, str], name: str) -> bool:
    resolved = shutil.which(name)
    return resolved is not None and Path(info["exe"]) == Path(resolved).resolve()


def service_command(info: dict[str, str], kind: str) -> bool:
    command = info["command"]
    if kind == "backend":
        if trusted_executable(info, "uv") and BACKEND_UV.match(command):
            return True
        backend_venv = Path(info["cwd"]) / ".venv" / "bin"
        exe = Path(info["exe"])
        return exe.parent == backend_venv and exe.name.startswith("python") and bool(BACKEND_PYTHON.match(command))
    if trusted_executable(info, "node") or trusted_executable(info, "npm"):
        return bool(FRONTEND_NPM.match(command) or FRONTEND_NODE_NPM.match(command) or FRONTEND_NEXT.match(command))
    return False


def service_root(info: dict[str, str], kind: str) -> Path | None:
    if not service_command(info, kind):
        return None
    cwd = Path(info["cwd"])
    if cwd.name != kind:
        return None
    root = cwd.parent.resolve()
    return root if (root / "frontend" / "package.json").is_file() and (root / "backend" / "pyproject.toml").is_file() else None


def worktrees() -> set[Path]:
    result = run("git", "-C", str(ROOT), "worktree", "list", "--porcelain")
    if result.returncode:
        raise ServiceError(f"Git worktree 목록을 읽지 못했습니다: {result.stderr.strip()}")
    return {Path(line[9:]).resolve() for line in result.stdout.splitlines() if line.startswith("worktree ")}


def listener_pids(port: int) -> set[int]:
    result = run("lsof", "-nP", "-tiTCP:" + str(port), "-sTCP:LISTEN")
    if result.returncode not in (0, 1):
        raise ServiceError(f"포트 {port} 점유 확인 실패: {result.stderr.strip()}")
    return {int(line) for line in result.stdout.splitlines() if line.isdigit()}


def owner_of_listener(pid: int, kind: str, allowed: set[Path]) -> dict[str, str]:
    current = pid
    seen: set[int] = set()
    owner = None
    while current > 1 and current not in seen:
        seen.add(current)
        info = process(current)
        if info is None:
            break
        root = service_root(info, kind)
        if root in allowed:
            owner = info  # Prefer the highest verified launcher in the ancestry.
        current = int(info["ppid"])
    if owner is None:
        visible = process(pid)
        detail = visible["command"] if visible else "명령/작업 디렉터리 확인 불가"
        raise ServiceError(f"PID {pid} ({detail})는 같은 저장소의 {kind} 서비스로 확인되지 않아 종료하지 않습니다.")
    return owner


def descendants(pid: int) -> list[int]:
    result = run("ps", "-axo", "pid=,ppid=")
    if result.returncode:
        raise ServiceError("프로세스 자식 목록을 읽지 못했습니다.")
    children: dict[int, list[int]] = {}
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) == 2 and all(field.isdigit() for field in fields):
            children.setdefault(int(fields[1]), []).append(int(fields[0]))
    found: list[int] = []
    def visit(parent: int) -> None:
        for child in children.get(parent, []):
            visit(child)
            found.append(child)
    visit(pid)
    return found


def terminate(owner: dict[str, str], kind: str, allowed_root: Path) -> None:
    pid = int(owner["pid"])
    fresh = process(pid)
    if fresh != owner or service_root(fresh, kind) != allowed_root:
        raise ServiceError(f"PID {pid}의 소속이 바뀌어 종료하지 않습니다.")
    tree = [process(child) for child in descendants(pid)]
    service_cwd = str(allowed_root / kind)
    tree = [item for item in tree if item and item["cwd"] == service_cwd]
    for item in tree + [owner]:
        if process(int(item["pid"])) == item:
            try:
                os.kill(int(item["pid"]), signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not any(process(int(item["pid"])) == item for item in tree + [owner]):
            return
        time.sleep(0.1)
    for item in tree + [owner]:
        if process(int(item["pid"])) == item:
            os.kill(int(item["pid"]), signal.SIGKILL)


def read_state() -> dict[str, dict[str, str]]:
    if not STATE_FILE.exists():
        return {}
    try:
        value = json.loads(STATE_FILE.read_text())
    except (OSError, ValueError) as exc:
        raise ServiceError(f"상태 파일을 읽지 못했습니다: {exc}") from exc
    if not isinstance(value, dict):
        raise ServiceError("상태 파일 형식이 올바르지 않습니다.")
    return value


def write_state(state: dict[str, dict[str, str]]) -> None:
    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.replace(STATE_FILE)


def same_process(recorded: dict[str, str], fresh: dict[str, str] | None) -> bool:
    # The launcher is reparented after start.sh exits; PPID is not an identity token.
    return fresh is not None and all(fresh.get(key) == recorded.get(key) for key in ("pid", "started", "command", "cwd", "exe"))


def stop_owned(state: dict[str, dict[str, str]]) -> None:
    for kind in reversed(KINDS):
        recorded = state.get(kind)
        if not recorded:
            continue
        try:
            pid = int(recorded["pid"])
        except (KeyError, ValueError, TypeError) as exc:
            raise ServiceError(f"{kind} 상태 파일의 PID가 올바르지 않습니다.") from exc
        fresh = process(pid)
        if same_process(recorded, fresh) and service_root(fresh, kind) == ROOT:
            terminate(fresh, kind, ROOT)
            print(f"{kind} 중지: PID {pid}")
        else:
            print(f"{kind} stale PID 제거: {pid}")
        state.pop(kind, None)
        write_state(state)
        if "port" in recorded and listener_pids(int(recorded["port"])):
            raise ServiceError(f"{kind} 포트 {recorded['port']}가 중지 후에도 점유 중입니다. 추가 프로세스는 종료하지 않습니다.")


def preflight(port_map: dict[str, int], state: dict[str, dict[str, str]]) -> list[tuple[dict[str, str], str, Path]]:
    allowed = worktrees()
    if ROOT not in allowed:
        raise ServiceError("현재 디렉터리가 이 Git 저장소의 worktree 목록에 없습니다.")
    blockers: dict[int, tuple[dict[str, str], str, Path]] = {}
    for kind in KINDS:
        for pid in listener_pids(port_map[kind]):
            owner = owner_of_listener(pid, kind, allowed)
            owner_root = service_root(owner, kind)
            if owner_root == ROOT:
                raise ServiceError(f"현재 worktree의 {kind} 서비스가 포트 {port_map[kind]}를 점유 중입니다. restart.sh를 사용하세요.")
            assert owner_root is not None
            blockers[int(owner["pid"])] = owner, kind, owner_root
    for kind, recorded in state.items():
        if kind in KINDS and same_process(recorded, process(int(recorded["pid"]))):
            raise ServiceError(f"현재 worktree의 {kind} PID가 살아 있습니다. restart.sh를 사용하세요.")
    return list(blockers.values())


def request(url: str) -> tuple[int, bytes] | None:
    try:
        with urlopen(Request(url, headers={"User-Agent": "gamja-service-check"}), timeout=2) as response:
            return response.status, response.read(4096)
    except HTTPError as exc:
        return exc.code, exc.read(4096)
    except (URLError, TimeoutError, OSError):
        return None


def belongs_to(pid: int, launcher: int) -> bool:
    seen: set[int] = set()
    while pid > 1 and pid not in seen:
        if pid == launcher:
            return True
        seen.add(pid)
        info = process(pid)
        if info is None:
            return False
        pid = int(info["ppid"])
    return False


def ready(kind: str, port: int, owner: dict[str, str], timeout: int) -> None:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/" + ("openapi.json" if kind == "backend" else "")
    while time.monotonic() < deadline:
        if process(int(owner["pid"])) != owner:
            raise ServiceError(f"{kind} 프로세스가 readiness 전에 종료되었습니다.")
        response = request(url)
        if response and response[0] == 200 and any(belongs_to(pid, int(owner["pid"])) for pid in listener_pids(port)):
            return
        time.sleep(0.4)
    raise ServiceError(f"{kind} HTTP readiness 시간 초과: {url}")


def start_service(kind: str, port: int, backend_port: int, state: dict[str, dict[str, str]], timeout: int) -> None:
    cwd = ROOT / kind
    log_dir = ROOT / "frontend" / "logs"
    log_dir.mkdir(exist_ok=True)
    log_path = log_dir / f"{kind}.log"
    if kind == "backend":
        argv = ["uv", "run", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", str(port)]
        env = os.environ.copy()
    else:
        argv = ["npm", "run", "dev", "--", "--hostname", "127.0.0.1", "--port", str(port)]
        env = os.environ.copy()
        env.pop("VERCEL", None)
        env["BACKEND_API_ORIGIN"] = f"http://127.0.0.1:{backend_port}"
    try:
        with log_path.open("a") as log:
            log.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] {' '.join(argv)}\n")
            log.flush()
            spawned = subprocess.Popen(argv, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as exc:
        raise ServiceError(f"{kind} 실행 실패: {exc}") from exc
    for _ in range(30):
        owner = process(spawned.pid)
        if owner and service_root(owner, kind) == ROOT:
            break
        if spawned.poll() is not None:
            try:
                os.killpg(spawned.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            raise ServiceError(f"{kind} 즉시 종료되었습니다. 로그: {log_path}")
        time.sleep(0.1)
    else:
        try:
            os.killpg(spawned.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        raise ServiceError(f"{kind} PID 소속을 확인하지 못했습니다: {spawned.pid}")
    state[kind] = {**owner, "port": str(port)}
    write_state(state)
    ready(kind, port, owner, timeout)
    print(f"{kind} 준비 완료: http://127.0.0.1:{port} (PID {spawned.pid}, 로그 {log_path})")


def validate_port(raw: str) -> int:
    value = int(raw)
    if not 1 <= value <= 65535:
        raise argparse.ArgumentTypeError("포트는 1..65535 범위여야 합니다.")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="현재 감자마켓 worktree의 Next.js/FastAPI 개발 서비스 제어")
    parser.add_argument("action", choices=("start", "restart", "stop"))
    parser.add_argument("--frontend-port", type=validate_port, default=3000)
    parser.add_argument("--backend-port", type=validate_port, default=8000)
    parser.add_argument("--timeout", type=int, default=60, help="각 서비스 HTTP readiness 제한(초), 기본 60")
    args = parser.parse_args()
    if args.frontend_port == args.backend_port:
        parser.error("frontend/backend 포트는 달라야 합니다.")
    if args.timeout < 1:
        parser.error("timeout은 1초 이상이어야 합니다.")
    STATE_DIR.mkdir(exist_ok=True)
    with (STATE_DIR / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = read_state()
        try:
            if args.action != "stop":
                if not (ROOT / "backend" / ".env").is_file():
                    raise ServiceError("backend/.env가 없습니다. .env.example을 복사하고 실제 DB 설정을 입력하세요.")
                if not (ROOT / "frontend" / "node_modules" / ".bin" / "next").exists():
                    raise ServiceError("frontend 의존성이 없습니다. (cd frontend && npm ci) 실행이 필요합니다.")
                for executable in ("uv", "npm", "lsof", "ps", "git"):
                    if shutil.which(executable) is None:
                        raise ServiceError(f"실행 파일이 없습니다: {executable}")
            if args.action in ("stop", "restart"):
                stop_owned(state)
            if args.action == "stop":
                return 0
            ports = {"frontend": args.frontend_port, "backend": args.backend_port}
            blockers = preflight(ports, state)
            for owner, kind, owner_root in blockers:
                print(f"다른 감자마켓 worktree 서비스 정리: {kind} PID {owner['pid']} ({owner_root})")
                terminate(owner, kind, owner_root)
            for kind in KINDS:
                if listener_pids(ports[kind]):
                    raise ServiceError(f"{kind} 포트 {ports[kind]}가 정리 후에도 점유 중입니다. 추가 프로세스는 종료하지 않습니다.")
            try:
                for kind in KINDS:
                    start_service(kind, ports[kind], args.backend_port, state, args.timeout)
                response = request(f"http://127.0.0.1:{args.frontend_port}/api/auth/me")
                try:
                    rewrite_code = json.loads(response[1]).get("error", {}).get("code") if response else None
                except (ValueError, AttributeError):
                    rewrite_code = None
                if not response or response[0] != 401 or rewrite_code != "UNAUTHENTICATED":
                    raise ServiceError("frontend /api/auth/me rewrite 확인 실패")
                print("frontend rewrite 확인 완료: /api/auth/me → FastAPI 401 UNAUTHENTICATED")
            except Exception:
                stop_owned(state)
                raise
            return 0
        except ServiceError as exc:
            print(f"오류: {exc}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    sys.exit(main())
