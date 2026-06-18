#!/usr/bin/env python3
"""Merge a staged .oste-report.yaml into a pending-review JSON document.

Usage:
    merge-completion-report.py <report_yaml> <pending_json_in> <out_json> <task_id>

Reads the launcher-owned completion report (YAML, with a stdlib fallback parser
when PyYAML is unavailable), reconciles it against the canonical pending-review
record (task_id, files_changed, test_commands/tests_passing claims), embeds it
under pending["report"], backfills agent_summary when empty, and writes the
result to <out_json>. Exits non-zero with "Error: ..." on any failure.

Extracted verbatim from oste-complete.sh:merge_completion_report_into_pending so
the merge can be unit-tested in isolation. Keep behavior identical.
"""
import json
import sys

try:
	import yaml
except ImportError:
	yaml = None


def normalize_string_list(value):
	if isinstance(value, str):
		items = [value]
	elif isinstance(value, list):
		items = value
	else:
		return []
	seen = set()
	normalized = []
	for item in items:
		if not isinstance(item, str):
			continue
		item = item.strip()
		if not item or item in seen:
			continue
		seen.add(item)
		normalized.append(item)
	return normalized


def parse_scalar(value):
	value = value.strip()
	if not value:
		return ""
	if (value.startswith("\"") and value.endswith("\"")) or (value.startswith("\047") and value.endswith("\047")):
		return value[1:-1]
	lowered = value.lower()
	if lowered == "true":
		return True
	if lowered == "false":
		return False
	if lowered in ("null", "~"):
		return None
	return value


def load_report(path):
	if yaml is not None:
		with open(path) as f_report:
			loaded = yaml.safe_load(f_report) or {}
		return loaded if isinstance(loaded, dict) else {}

	# Fallback parser for the launcher-owned .oste-report.yaml shape:
	# top-level scalar keys plus simple "- item" string lists.
	report = {}
	current_list_key = None
	with open(path) as f_report:
		for raw_line in f_report:
			line = raw_line.rstrip("\n")
			stripped = line.strip()
			if not stripped or stripped.startswith("#"):
				continue
			if line[:1].isspace() and current_list_key:
				if stripped.startswith("- "):
					report.setdefault(current_list_key, []).append(parse_scalar(stripped[2:]))
				continue
			current_list_key = None
			if ":" not in stripped:
				continue
			key, value = stripped.split(":", 1)
			key = key.strip()
			value = value.strip()
			if not key:
				continue
			if value == "":
				report[key] = []
				current_list_key = key
			else:
				report[key] = parse_scalar(value)
	return report


def main():
	try:
		report = load_report(sys.argv[1])
		with open(sys.argv[2]) as f_pending:
			pending = json.load(f_pending)

		canonical_task_id = sys.argv[4]
		report_tid = report.get("task_id")
		report_orig_tid = report.get("original_task_id")

		def _mismatch(value):
			return isinstance(value, str) and value and value != canonical_task_id

		# Task-id provenance gate: a report whose declared identity belongs to a
		# different task must never be adopted into this task's pending review.
		# Preserve git-derived pending metadata and record a rejection breadcrumb.
		if _mismatch(report_tid) or _mismatch(report_orig_tid):
			pending["report_rejected"] = {
				"reason": "task_id_mismatch",
				"expected_task_id": canonical_task_id,
				"report_task_id": report_tid if isinstance(report_tid, str) else None,
				"report_original_task_id": report_orig_tid if isinstance(report_orig_tid, str) else None,
			}
			with open(sys.argv[3], "w") as f_out:
				json.dump(pending, f_out, indent=2)
			return

		if not report_tid:
			report["task_id"] = canonical_task_id

		canonical_files = pending.get("files_changed")
		if canonical_files:
			report["files_changed"] = canonical_files
		elif report.get("files_changed"):
			pending["files_changed"] = report["files_changed"]

		test_commands = normalize_string_list(report.get("test_commands"))
		if test_commands:
			report["test_commands"] = test_commands
		else:
			report.pop("test_commands", None)

		claimed_tests_passing = report.get("tests_passing")
		if isinstance(claimed_tests_passing, bool):
			if test_commands:
				report["tests_passing"] = claimed_tests_passing
				report.pop("tests_passing_claimed", None)
			else:
				report["tests_passing_claimed"] = claimed_tests_passing
				report["tests_passing"] = None
		else:
			if claimed_tests_passing is not None:
				report["tests_passing_claimed"] = claimed_tests_passing
			report["tests_passing"] = None

		pending["report"] = report

		pending_summary = pending.get("agent_summary")
		if (not isinstance(pending_summary, str) or not pending_summary.strip()):
			report_summary = report.get("summary")
			if isinstance(report_summary, str) and report_summary.strip():
				pending["agent_summary"] = report_summary.strip()

		with open(sys.argv[3], "w") as f_out:
			json.dump(pending, f_out, indent=2)
	except Exception as e:
		sys.exit(f"Error: {e}")


if __name__ == "__main__":
	main()
