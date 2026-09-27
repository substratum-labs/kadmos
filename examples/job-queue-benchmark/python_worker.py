"""Small redis-py Fabric; use redis.Redis(decode_responses=True) for real I/O."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent / "spec"))
from world_checker import WorldChecker  # noqa: E402 - generated checker imports ports directly


class MemoryRedis:
    """Offline Redis command subset. Pass a redis.Redis client for real I/O."""

    def __init__(self) -> None:
        self.lists: dict[str, list[str]] = {}
        self.strings: dict[str, str] = {}
        self.sets: dict[str, dict[str, float]] = {}

    def lpush(self, key: str, value: str) -> int:
        items = self.lists.setdefault(key, [])
        items.insert(0, value)
        return len(items)

    def lpop(self, key: str) -> str | None:
        items = self.lists.get(key, [])
        return items.pop(0) if items else None

    def lrem(self, key: str, count: int, value: str) -> int:
        items = self.lists.get(key, [])
        removed = 0
        for item in items[:]:
            if item == value and (count == 0 or removed < count):
                items.remove(item)
                removed += 1
        return removed

    def rpoplpush(self, source: str, destination: str) -> str | None:
        items = self.lists.get(source, [])
        if not items:
            return None
        value = items.pop()
        self.lpush(destination, value)
        return value

    def set(self, key: str, value: str) -> bool:
        self.strings[key] = value
        return True

    def get(self, key: str) -> str | None:
        return self.strings.get(key)

    def delete(self, key: str) -> int:
        return int(self.strings.pop(key, None) is not None)

    def zadd(self, key: str, mapping: dict[str, float]) -> int:
        target = self.sets.setdefault(key, {})
        added = sum(value not in target for value in mapping)
        target.update(mapping)
        return added

    def zrangebyscore(self, key: str, lower: float | str, upper: float | str) -> list[str]:
        return [value for value, score in sorted(self.sets.get(key, {}).items(), key=lambda item: item[1])
                if float(lower) <= score <= float(upper)]

    def zrem(self, key: str, value: str) -> int:
        return int(self.sets.get(key, {}).pop(value, None) is not None)


class JobWorker:
    def __init__(self, redis: Any, checker: WorldChecker, job_id: str) -> None:
        self.redis, self.checker, self.job_id = redis, checker, job_id
        self.last_rejection: dict[str, Any] | None = None

    def permit(self, transition: str, directive: str, **payload: str) -> bool:
        verdict = self.checker.step({"transitionId": transition, "proposedDirective": directive,
                                     "eventPayload": payload})
        if not verdict["allowed"] or verdict["directiveAllowed"] != directive:
            self.last_rejection = verdict
            return False
        self.last_rejection = None
        return True

    def enqueue(self) -> None:
        self.redis.lpush("jobs:wait", self.job_id)

    def begin(self, token: str) -> bool:
        job_id = self.redis.rpoplpush("jobs:wait", "jobs:active")
        if job_id != self.job_id:
            return False
        if not self.permit("ACQUIRE_LOCK", "DISPATCH_PAYLOAD", token=token):
            self.redis.lrem("jobs:active", 1, job_id)
            self.redis.lpush("jobs:wait", job_id)
            return False
        self.redis.set(f"{self.job_id}:lock", token)
        return True

    def succeed(self, token: str, result_digest: str) -> bool:
        if not self.permit("REPORT_SUCCESS", "PERSIST_RESULT", token=token,
                           result_digest=result_digest):
            return False
        self.redis.set(f"{self.job_id}:result", result_digest)
        self.redis.delete(f"{self.job_id}:lock")
        self.redis.lrem("jobs:active", 1, self.job_id)
        return True

    def fail(self, token: str, reason: str, due_at: float, fatal: bool = False) -> bool:
        context = self.checker.get_context()
        exhausted = context["retries"] >= context["max_retries"]
        transition = "REPORT_FATAL_FAILURE" if fatal else "RETRY_EXHAUSTED" if exhausted else "REPORT_RETRYABLE_FAILURE"
        directive = "TRIGGER_DEAD_LETTER_ALERT" if fatal or exhausted else "SCHEDULE_BACKOFF"
        if not self.permit(transition, directive, token=token, reason=reason):
            return False
        self.redis.delete(f"{self.job_id}:lock")
        self.redis.lrem("jobs:active", 1, self.job_id)
        if directive == "SCHEDULE_BACKOFF":
            self.redis.zadd("jobs:delayed", {self.job_id: due_at})
        else:
            self.redis.lpush("jobs:dead", self.job_id)
        return True

    def wake_due(self, now: float) -> bool:
        due = self.redis.zrangebyscore("jobs:delayed", "-inf", now)
        if self.job_id not in due or not self.permit("RETRY_DELAY_ELAPSED", "ENQUEUE_FOR_PICKUP"):
            return False
        self.redis.zrem("jobs:delayed", self.job_id)
        self.enqueue()
        return True


def self_test() -> dict[str, str]:
    outcomes: dict[str, str] = {}
    for scenario in ("happy", "recovery", "exhausted", "fencing"):
        redis, checker = MemoryRedis(), WorldChecker()
        worker = JobWorker(redis, checker, "job-42")
        worker.enqueue()
        if scenario == "fencing":
            assert worker.begin("worker-a")
            checker.reset({"lock_epoch": 1})  # Supervisor recovered expired lease.
            redis.delete("job-42:lock")
            worker.enqueue()
            assert worker.begin("worker-b")
            assert not worker.succeed("worker-a", "stale")
            assert worker.last_rejection["violation"]["code"] == "GUARD_FAILED"
            assert redis.get("job-42:lock") == "worker-b"
            assert redis.get("job-42:result") is None
            assert worker.succeed("worker-b", "fresh")
        elif scenario == "happy":
            assert worker.begin("worker-a") and worker.succeed("worker-a", "digest")
        else:
            failures = 1 if scenario == "recovery" else 3
            for attempt in range(1, failures + 1):
                token = f"worker-{attempt}"
                assert worker.begin(token) and worker.fail(token, "503", attempt)
                assert checker.get_state() == "DELAYED_RETRY"
                assert not worker.wake_due(attempt - 1)
                assert worker.wake_due(attempt)
            token = "last-worker"
            assert worker.begin(token)
            if scenario == "recovery":
                assert worker.succeed(token, "recovered")
                assert redis.get("job-42:result") == "recovered"
            else:
                assert worker.fail(token, "503", 4)
                assert checker.get_context()["retries"] == 3
                assert redis.lpop("jobs:dead") == "job-42"
        assert redis.get("job-42:lock") is None
        outcomes[scenario] = checker.get_state()
    return outcomes


if __name__ == "__main__" and sys.argv[1:] == ["--self-test"]:
    print(json.dumps(self_test()))
