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

    def _settle(self, transition: str, directive: str, payload: dict[str, str], effect: Any) -> bool:
        lock_key = f"{self.job_id}:lock"
        result_key = f"{self.job_id}:result"
        lock, result = self.redis.get(lock_key), self.redis.get(result_key)
        if not self.permit(transition, directive, **payload):
            return False
        try:
            effect()
            return True
        except Exception:
            self.checker.rollback_last_step()
            self.redis.lrem("jobs:wait", 0, self.job_id)
            self.redis.zrem("jobs:delayed", self.job_id)
            self.redis.lrem("jobs:dead", 0, self.job_id)
            if result is None:
                self.redis.delete(result_key)
            else:
                self.redis.set(result_key, result)
            if lock is None:
                self.redis.delete(lock_key)
            else:
                self.redis.set(lock_key, lock)
            self.redis.lrem("jobs:active", 0, self.job_id)
            self.redis.lpush("jobs:active", self.job_id)
            raise

    def enqueue(self) -> None:
        self.redis.lpush("jobs:wait", self.job_id)

    def begin(self, token: str) -> bool:
        job_id = self.redis.rpoplpush("jobs:wait", "jobs:active")
        if job_id is None:
            return False
        if job_id != self.job_id:
            self.redis.lrem("jobs:active", 1, job_id)
            self.redis.lpush("jobs:wait", job_id)
            return False
        if not self.permit("ACQUIRE_LOCK", "DISPATCH_PAYLOAD", token=token):
            self.redis.lrem("jobs:active", 1, job_id)
            self.redis.lpush("jobs:wait", job_id)
            return False
        self.redis.set(f"{self.job_id}:lock", token)
        return True

    def recover_lease(self, supervisor_token: str) -> bool:
        def effect() -> None:
            self.redis.delete(f"{self.job_id}:lock")
            self.redis.lrem("jobs:active", 1, self.job_id)
            self.enqueue()
        return self._settle("RECOVER_STALE_LEASE", "EVICT_STALE_WORKER", {"supervisor_token": supervisor_token}, effect)

    def succeed(self, token: str, result_digest: str) -> bool:
        def effect() -> None:
            self.redis.set(f"{self.job_id}:result", result_digest)
            self.redis.delete(f"{self.job_id}:lock")
            self.redis.lrem("jobs:active", 1, self.job_id)
        return self._settle("REPORT_SUCCESS", "PERSIST_RESULT", {"token": token, "result_digest": result_digest}, effect)

    def fail(self, token: str, reason: str, due_at: float, fatal: bool = False) -> bool:
        context = self.checker.get_context()
        exhausted = context["retries"] >= context["max_retries"]
        transition = "REPORT_FATAL_FAILURE" if fatal else "RETRY_EXHAUSTED" if exhausted else "REPORT_RETRYABLE_FAILURE"
        directive = "TRIGGER_DEAD_LETTER_ALERT" if fatal or exhausted else "SCHEDULE_BACKOFF"
        def effect() -> None:
            self.redis.delete(f"{self.job_id}:lock")
            self.redis.lrem("jobs:active", 1, self.job_id)
            if directive == "SCHEDULE_BACKOFF":
                self.redis.zadd("jobs:delayed", {self.job_id: due_at})
            else:
                self.redis.lpush("jobs:dead", self.job_id)
        return self._settle(transition, directive, {"token": token, "reason": reason}, effect)

    def wake_due(self, now: float) -> bool:
        due = self.redis.zrangebyscore("jobs:delayed", "-inf", now)
        if self.job_id not in due:
            return False
        try:
            if not self.redis.zrem("jobs:delayed", self.job_id):
                return False
            self.enqueue()
            if self.permit("RETRY_DELAY_ELAPSED", "ENQUEUE_FOR_PICKUP"):
                return True
        except Exception:
            self.redis.lrem("jobs:wait", 1, self.job_id)
            self.redis.zadd("jobs:delayed", {self.job_id: now})
            raise
        self.redis.lrem("jobs:wait", 1, self.job_id)
        self.redis.zadd("jobs:delayed", {self.job_id: now})
        return False


def self_test() -> dict[str, str]:
    outcomes: dict[str, str] = {}
    for scenario in ("happy", "recovery", "exhausted", "fencing"):
        redis, checker = MemoryRedis(), WorldChecker()
        worker = JobWorker(redis, checker, "job-42")
        worker.enqueue()
        if scenario == "fencing":
            assert worker.begin("worker-a")
            assert worker.recover_lease("supervisor-token")
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
    class ThrowingRedis(MemoryRedis):
        fail_wait_push = False

        def lpush(self, key: str, value: str) -> int:
            count = super().lpush(key, value)
            if key == "jobs:wait" and self.fail_wait_push:
                self.fail_wait_push = False
                raise RuntimeError("injected Redis failure")
            return count

    redis, checker = ThrowingRedis(), WorldChecker()
    worker = JobWorker(redis, checker, "job-42")
    worker.enqueue()
    assert worker.begin("worker-a") and worker.fail("worker-a", "503", 100)
    redis.fail_wait_push = True
    try:
        worker.wake_due(100)
        raise AssertionError("Redis failure was not propagated")
    except RuntimeError as error:
        assert str(error) == "injected Redis failure"
    assert checker.get_state() == "DELAYED_RETRY"
    assert redis.zrangebyscore("jobs:delayed", "-inf", 100) == ["job-42"]
    assert redis.lpop("jobs:wait") is None
    assert worker.wake_due(100)
    outcomes["rollback"] = "DELAYED_RETRY"
    class SettlementRedis(MemoryRedis):
        fail_key: str | None = None

        def hit(self, key: str) -> None:
            if self.fail_key == key:
                self.fail_key = None
                raise RuntimeError("injected Redis failure")

        def lpush(self, key: str, value: str) -> int:
            result = super().lpush(key, value)
            self.hit(key)
            return result

        def zadd(self, key: str, mapping: dict[str, float]) -> int:
            result = super().zadd(key, mapping)
            self.hit(key)
            return result

        def set(self, key: str, value: str) -> bool:
            result = super().set(key, value)
            self.hit(key)
            return result

    for scenario, key in (("recover", "jobs:wait"), ("retry", "jobs:delayed"),
                          ("fatal", "jobs:dead"), ("succeed", "job-42:result")):
        redis, checker = SettlementRedis(), WorldChecker()
        worker = JobWorker(redis, checker, "job-42")
        worker.enqueue()
        assert worker.begin("worker-a")
        before = checker.get_context()
        redis.fail_key = key
        def attempt() -> bool:
            if scenario == "recover":
                return worker.recover_lease("supervisor")
            if scenario == "retry":
                return worker.fail("worker-a", "503", 100)
            if scenario == "fatal":
                return worker.fail("worker-a", "fatal", 100, True)
            return worker.succeed("worker-a", "digest")
        try:
            attempt()
            raise AssertionError("Redis failure was not propagated")
        except RuntimeError as error:
            assert str(error) == "injected Redis failure"
        assert checker.get_state() == "ACTIVE"
        assert checker.get_context() == before
        assert redis.get("job-42:lock") == "worker-a"
        assert redis.get("job-42:result") is None
        assert redis.lpop("jobs:wait") is None
        assert redis.lpop("jobs:dead") is None
        assert redis.zrangebyscore("jobs:delayed", "-inf", "+inf") == []
        assert redis.lpop("jobs:active") == "job-42"
        redis.lpush("jobs:active", "job-42")
        assert attempt()
        outcomes[scenario + "_rollback"] = "ACTIVE"
    return outcomes


if __name__ == "__main__" and sys.argv[1:] == ["--self-test"]:
    print(json.dumps(self_test()))
