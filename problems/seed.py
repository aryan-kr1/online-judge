#!/usr/bin/env python3
"""
Seed the online judge with problems and test cases through the admin API.

For each problem:
  1. run generator.py <seed> <mode> to get the input
  2. run solution.py on that input to get the expected output
  3. create the problem (or update it if the slug exists)
  4. replace its test cases (first one is the sample)

Safe to re-run. Standard library only.

Environment variables:
  OJ_ADMIN_EMAIL     admin account email (required)
  OJ_ADMIN_PASSWORD  admin account password (required)
  OJ_BASE_URL        default http://localhost:3000
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE_URL = os.environ.get("OJ_BASE_URL", "http://localhost:3000").rstrip("/")
ADMIN_EMAIL = os.environ.get("OJ_ADMIN_EMAIL")
ADMIN_PASSWORD = os.environ.get("OJ_ADMIN_PASSWORD")

HERE = Path(__file__).resolve().parent
RUN_TIMEOUT_SECONDS = 30

# ---------------------------------------------------------------------------
# API shape. If your routes use different names, change them here only.
# ---------------------------------------------------------------------------

LOGIN_PATH = "/api/auth/login"
PROBLEMS_PATH = "/api/problems"
UPDATE_METHOD = "PUT"  # change to "PATCH" if your update route uses PATCH


def problem_body(p, reference_solution, test_generator):
    """JSON body sent when creating or updating a problem."""
    return {
        "slug": p["slug"],
        "title": p["title"],
        "statement": p["statement"],
        "time_limit_ms": p["time_limit_ms"],
        "memory_limit_mb": p["memory_limit_mb"],
        "reference_solution": reference_solution,
        "test_generator": test_generator,
    }


def test_case_body(input_text, expected_output, is_sample):
    """JSON body sent when adding one test case."""
    return {
        "input": input_text,
        "expected_output": expected_output,
        "is_sample": is_sample,
    }


# ---------------------------------------------------------------------------
# Problems. The first (seed, mode) pair of each problem becomes the sample,
# so keep it small. Modes must be ones that problem's generator.py accepts.
# ---------------------------------------------------------------------------

PROBLEMS = [
    {
        "slug": "add-two-numbers",
        "title": "Add Two Numbers",
        "time_limit_ms": 1000,
        "memory_limit_mb": 256,
        "statement": (
            "Given two integers `a` and `b`, print their sum.\n\n"
            "## Input\n"
            "One line with two integers `a` and `b`.\n\n"
            "## Output\n"
            "A single integer, `a + b`.\n\n"
            "## Constraints\n"
            "- |a|, |b| <= 10^9\n\n"
            "## Example\n"
            "Input:\n```\n2 3\n```\n"
            "Output:\n```\n5\n```\n"
        ),
        "tests": [
            (1, "small"),
            (2, "small"),
            (3, "medium"),
            (4, "medium"),
            (5, "medium"),
            (6, "edge"),
            (7, "edge"),
            (8, "large"),
            (9, "large"),
        ],
    },
    {
        "slug": "sum-of-array",
        "title": "Sum of Array",
        "time_limit_ms": 1000,
        "memory_limit_mb": 256,
        "statement": (
            "Given an array of `n` integers, print the sum of all its elements.\n\n"
            "## Input\n"
            "The first line contains `n`. The second line contains `n` integers.\n\n"
            "## Output\n"
            "A single integer, the sum of the array.\n\n"
            "## Constraints\n"
            "- 1 <= n <= 200000\n"
            "- |a_i| <= 10^9\n"
            "- The sum can exceed 32 bits, so use a 64-bit type.\n\n"
            "## Example\n"
            "Input:\n```\n3\n1 2 3\n```\n"
            "Output:\n```\n6\n```\n"
        ),
        "tests": [
            (1, "small"),
            (2, "single"),
            (3, "small"),
            (4, "medium"),
            (5, "medium"),
            (6, "max_positive"),
            (7, "max_negative"),
            (8, "large"),
            (9, "large"),
            (10, "large"),
        ],
    },
    {
        "slug": "two-sum-exists",
        "title": "Two Sum Exists",
        "time_limit_ms": 2000,
        "memory_limit_mb": 256,
        # NOTE: the input format below is a guess. Compare it with the real
        # output of `python3 two-sum-exists/generator.py 1 small` and fix it.
        "statement": (
            "Given an array of `n` integers and a target `k`, decide whether "
            "there are two different positions `i != j` with `a_i + a_j = k`.\n\n"
            "## Input\n"
            "The first line contains `n` and `k`. The second line contains "
            "`n` integers.\n\n"
            "## Output\n"
            "Print `YES` if such a pair exists, otherwise `NO`.\n\n"
            "## Constraints\n"
            "- 2 <= n <= 200000\n"
            "- Values fit in 64-bit integers.\n"
            "- An O(n^2) solution will be too slow on the large tests.\n\n"
            "## Example\n"
            "Input:\n```\n4 9\n2 7 11 15\n```\n"
            "Output:\n```\nYES\n```\n"
        ),
        "tests": [
            (1, "small"),
            (2, "small"),
            (3, "edge"),
            (4, "edge"),
            (5, "medium_yes"),
            (6, "medium_no"),
            (7, "large_no"),
            (8, "large_yes_late"),
            (9, "large_no"),
            (10, "large_yes_late"),
        ],
    },
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def die(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def api(method, path, token=None, body=None):
    """Call the API. Returns (status_code, parsed_json_or_text)."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE_URL + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw
    except urllib.error.URLError as e:
        die(f"cannot reach {BASE_URL} ({e.reason}). Is the server running?")


def unwrap(payload, *keys):
    """Return payload[key] if the API wraps its result, else payload itself."""
    if isinstance(payload, dict):
        for key in keys:
            if key in payload:
                return payload[key]
    return payload


def run_script(script, args=(), stdin_text=None):
    """Run a Python script and return its stdout. Exits on failure."""
    cmd = ["python3", str(script), *map(str, args)]
    try:
        result = subprocess.run(
            cmd,
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        die(f"timed out: {' '.join(cmd)}")
    if result.returncode != 0:
        die(f"failed: {' '.join(cmd)}\n{result.stderr.strip()}")
    return result.stdout


def login():
    status, payload = api(
        "POST", LOGIN_PATH, body={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    if status != 200 or not isinstance(payload, dict) or "token" not in payload:
        die(f"login failed ({status}): {payload}")
    return payload["token"]


def find_problem(slug, token):
    """Return the existing problem dict for a slug, or None."""
    status, payload = api("GET", f"{PROBLEMS_PATH}/{slug}", token=token)
    if status == 404:
        return None
    if status != 200:
        die(f"could not look up '{slug}' ({status}): {payload}")
    problem = unwrap(payload, "problem")
    if not isinstance(problem, dict) or "id" not in problem:
        die(f"unexpected response when looking up '{slug}': {payload}")
    return problem


def clear_test_cases(problem_id, token):
    status, payload = api(
        "GET", f"{PROBLEMS_PATH}/{problem_id}/test-cases", token=token
    )
    if status != 200:
        die(f"could not list test cases ({status}): {payload}")
    cases = unwrap(payload, "test_cases", "testCases")
    if not isinstance(cases, list):
        die(f"unexpected test case list response: {payload}")
    for case in cases:
        status, payload = api(
            "DELETE",
            f"{PROBLEMS_PATH}/{problem_id}/test-cases/{case['id']}",
            token=token,
        )
        if status not in (200, 204):
            die(f"could not delete test case {case['id']} ({status}): {payload}")
    return len(cases)


def build_test_data(p):
    """Generate (input, expected_output, label) for every test of a problem."""
    folder = HERE / p["slug"]
    generator = folder / "generator.py"
    solution = folder / "solution.py"
    for f in (generator, solution):
        if not f.exists():
            die(f"missing file: {f}")

    data = []
    for seed, mode in p["tests"]:
        input_text = run_script(generator, (seed, mode))
        expected = run_script(solution, stdin_text=input_text).strip() + "\n"
        data.append((input_text, expected, f"seed={seed} mode={mode}"))
    return data


def seed_problem(p, token):
    slug = p["slug"]
    print(f"\n== {slug} ==")

    folder = HERE / slug
    reference_solution = (folder / "solution.py").read_text()
    test_generator = (folder / "generator.py").read_text()

    print("generating tests...")
    tests = build_test_data(p)

    body = problem_body(p, reference_solution, test_generator)
    existing = find_problem(slug, token)

    if existing is None:
        status, payload = api("POST", PROBLEMS_PATH, token=token, body=body)
        if status not in (200, 201):
            die(f"could not create '{slug}' ({status}): {payload}")
        created = unwrap(payload, "problem")
        problem_id = created["id"]
        print(f"created problem id {problem_id}")
    else:
        problem_id = existing["id"]
        status, payload = api(
            UPDATE_METHOD, f"{PROBLEMS_PATH}/{problem_id}", token=token, body=body
        )
        if status != 200:
            die(f"could not update '{slug}' ({status}): {payload}")
        removed = clear_test_cases(problem_id, token)
        print(f"updated problem id {problem_id}, removed {removed} old test cases")

    for index, (input_text, expected, label) in enumerate(tests):
        is_sample = index == 0
        status, payload = api(
            "POST",
            f"{PROBLEMS_PATH}/{problem_id}/test-cases",
            token=token,
            body=test_case_body(input_text, expected, is_sample),
        )
        if status not in (200, 201):
            die(f"could not add test case {index + 1} ({status}): {payload}")
        preview = expected.strip()[:20]
        print(
            f"  test {index + 1:>2} {label:<18} input={len(input_text):>8} bytes "
            f"expected={preview!r}{' [sample]' if is_sample else ''}"
        )


def main():
    if not ADMIN_EMAIL or not ADMIN_PASSWORD:
        die("set OJ_ADMIN_EMAIL and OJ_ADMIN_PASSWORD first")

    token = login()
    print("logged in as admin")

    for p in PROBLEMS:
        seed_problem(p, token)

    print("\nDone.")


if __name__ == "__main__":
    main()
