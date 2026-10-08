"""Secrets never reach a log line: keys in messages, fields and exceptions are scrubbed."""

import json

from ancile_knowledge.obs import configure_logging, get_logger

CANARIES = [
    "sk-ant-api03-CANARYcanary1234567890",
    "sk-or-v1-CANARYcanary1234567890abcd",
    "hf_CANARYcanary1234567890abcd",
    "postgresql+psycopg://ancile:CANARYpass1234@localhost/ancile",
]


def test_keys_never_reach_the_log(capsys):
    configure_logging("info")
    log = get_logger("canary")
    for key in CANARIES:
        log.warning(f"provider said: invalid key {key}")
        log.info("calling", api_key=key, detail={"text": f"echo {key}"}, urls=[key])
        try:
            raise RuntimeError(f"401 for {key}")
        except RuntimeError:
            log.exception("failed")
    out = capsys.readouterr().out
    lines = [json.loads(line) for line in out.splitlines() if line.startswith("{")]
    assert len(lines) >= len(CANARIES) * 3
    assert "CANARY" not in out
