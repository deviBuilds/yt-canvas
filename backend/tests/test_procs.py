import sys
import time

import pytest

from app.procs import OutputLimitExceeded, ProcessTimeout, run_process

pytestmark = pytest.mark.anyio

PY = sys.executable


async def test_captures_stdout_and_exit_code():
    result = await run_process([PY, "-c", "import sys; print('hi'); sys.exit(3)"], timeout=10)
    assert result.returncode == 3
    assert result.stdout.strip() == b"hi"


async def test_arguments_are_not_shell_interpreted(tmp_path):
    marker = tmp_path / "pwned"
    evil = f"; touch {marker}; $(touch {marker})"
    result = await run_process([PY, "-c", "import sys; print(sys.argv[1])", evil], timeout=10)
    assert result.stdout.decode().strip() == evil
    assert not marker.exists()


async def test_rejects_string_commands():
    with pytest.raises(TypeError):
        await run_process("echo hi", timeout=5)  # type: ignore[arg-type]


async def test_timeout_kills_the_process_group():
    script = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); time.sleep(60)"
    started = time.monotonic()
    with pytest.raises(ProcessTimeout):
        await run_process([PY, "-c", script], timeout=1)
    assert time.monotonic() - started < 10


async def test_output_is_bounded():
    with pytest.raises(OutputLimitExceeded):
        await run_process([PY, "-c", "import sys; sys.stdout.write('x' * 1_000_000)"], timeout=10,
                          max_stdout=10_000)


async def test_line_streaming_handles_carriage_returns_and_long_lines():
    lines = []
    script = "import sys; sys.stdout.write('a\\rb\\nc\\n' + 'z' * 40000 + '\\n')"
    await run_process([PY, "-c", script], timeout=10, on_stdout_line=lines.append)
    assert lines[:3] == ["a", "b", "c"]
    assert all(len(line) <= 16 * 1024 for line in lines)


async def test_stderr_tail_is_kept():
    result = await run_process([PY, "-c", "import sys; sys.stderr.write('boom\\n')"], timeout=10)
    assert "boom" in result.stderr_tail


async def test_cancellation_kills_child(tmp_path):
    import os

    import anyio

    pid_file = tmp_path / "pid"
    script = f"import os,time; open({str(pid_file)!r},'w').write(str(os.getpid())); time.sleep(30)"
    with anyio.move_on_after(1.0):
        await run_process([PY, "-c", script], timeout=60)
    pid = int(pid_file.read_text())
    for _ in range(50):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        await anyio.sleep(0.1)
    pytest.fail("child process survived cancellation")
