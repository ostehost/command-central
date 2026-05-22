#!/usr/bin/env python3
"""stream-formatter.sh — Live stream-json to human-readable terminal output.

Usage: claude -p "task" --output-format=stream-json | tee raw.jsonl | stream-formatter.sh

Reads stream-json on stdin, outputs formatted text to stdout in real-time.
Designed to be piped in the terminal so Cmd+Tab shows readable output.
"""
import sys
import json
import time
import os

is_tty = os.isatty(1)
BOLD = '\033[1m' if is_tty else ''
DIM = '\033[2m' if is_tty else ''
RESET = '\033[0m' if is_tty else ''
GREEN = '\033[32m' if is_tty else ''
YELLOW = '\033[33m' if is_tty else ''
BLUE = '\033[34m' if is_tty else ''
CYAN = '\033[36m' if is_tty else ''
RED = '\033[31m' if is_tty else ''
MAGENTA = '\033[35m' if is_tty else ''
GRAY = '\033[90m' if is_tty else ''

start_time = time.time()
task_id = os.environ.get("OSTE_TASK_ID", "")
task_role = os.environ.get("OSTE_TASK_ROLE", "")
project_name = os.environ.get("OSTE_PROJECT_NAME", "")
session_id = os.environ.get("OSTE_SESSION_ID", "")
current_block_type = None
tool_name = None
tool_input_json = ""
thinking_chars = 0
THINKING_MAX_CHARS = 200  # Show first N chars of each thinking block

def elapsed():
    mins, secs = divmod(int(time.time() - start_time), 60)
    return f"{mins}:{secs:02d}"

def format_banner(model="", cwd=""):
    """Build the session identity banner."""
    # Line 1: task identity
    parts1 = []
    parts1.append(f"🚀 {task_id}" if task_id else "🚀 Agent session")
    if project_name:
        parts1.append(project_name)
    if task_role:
        parts1.append(task_role)
    line1 = f"{BOLD}{' · '.join(parts1)}{RESET}"

    # Line 2: model + cwd
    parts2 = []
    if model:
        # Strip context suffix like [1m] for cleaner display
        clean_model = model.split("[")[0] if "[" in model else model
        parts2.append(clean_model)
    if cwd:
        parts2.append(f"📁 {cwd}")
    line2 = f"   {GRAY}{' · '.join(parts2)}{RESET}" if parts2 else ""

    sep = f"   {GRAY}{'─' * 45}{RESET}"

    print(line1, flush=True)
    if line2:
        print(line2, flush=True)
    print(sep, flush=True)
    print("", flush=True)

def flush_block():
    global current_block_type, thinking_chars
    if current_block_type == "thinking":
        if thinking_chars > 0:
            print(f"\n{GRAY}{'─'*50}{RESET}", flush=True)
        thinking_chars = 0
    elif current_block_type == "text":
        print("", flush=True)
    current_block_type = None

def format_codex_event(d):
    """Handle Codex CLI --json events (thread.started, item.completed, etc.)."""
    msg_type = d.get("type", "")

    if msg_type == "thread.started":
        format_banner(model="codex")
        return True

    if msg_type == "turn.started":
        return True  # silent

    if msg_type == "item.started":
        return True  # wait for item.completed

    if msg_type == "item.completed":
        item = d.get("item", {})
        item_type = item.get("type", "")

        if item_type == "agent_message":
            text = item.get("text", "")
            if text:
                # Show first 300 chars of agent reasoning
                show = text[:300]
                if len(text) > 300:
                    show += "..."
                print(f"{BLUE}💬 Agent{RESET} {GRAY}[{elapsed()}]{RESET}", flush=True)
                print(f"   {show}", flush=True)
                print("", flush=True)
            return True

        if item_type == "command_execution":
            cmd = item.get("command", "?")
            if isinstance(cmd, list):
                cmd = " ".join(cmd)
            if len(cmd) > 70:
                cmd = cmd[:67] + "..."
            exit_code = item.get("exit_code")
            status = item.get("status", "")
            if exit_code is not None and exit_code != 0:
                status_icon = f" {RED}✗ (exit {exit_code}){RESET}"
            elif status == "completed" or exit_code == 0:
                status_icon = f" {GREEN}✓{RESET}"
            else:
                status_icon = ""
            output = item.get("aggregated_output", "")
            print(f"{CYAN}🔨 shell{RESET}  {cmd}{status_icon} {GRAY}[{elapsed()}]{RESET}", flush=True)
            if output and exit_code and exit_code != 0:
                snippet = output[:200] + ("..." if len(output) > 200 else "")
                print(f"   {GRAY}{snippet}{RESET}", flush=True)
            return True

        if item_type == "file_change":
            changes = item.get("changes", [])
            status = item.get("status", "")
            status_icon = f" {GREEN}✓{RESET}" if status == "completed" else ""
            if changes:
                for change in changes[:3]:
                    path = change.get("path", "?")
                    kind = change.get("kind", "change")
                    path = path.replace(os.path.expanduser("~"), "~")
                    if len(path) > 65:
                        path = ".../" + "/".join(path.split("/")[-2:])
                    icon = {"create": "✏️ ", "delete": "🗑️ ", "modify": "🔧"}.get(kind, "📝")
                    print(f"{CYAN}{icon} {kind}{RESET}  {path}{status_icon} {GRAY}[{elapsed()}]{RESET}", flush=True)
                if len(changes) > 3:
                    print(f"   {GRAY}... and {len(changes) - 3} more{RESET}", flush=True)
            else:
                print(f"{CYAN}📝 file_change{RESET}{status_icon} {GRAY}[{elapsed()}]{RESET}", flush=True)
            return True

        if item_type == "todo_list":
            items = item.get("items", [])
            done = sum(1 for i in items if i.get("completed"))
            print(f"{CYAN}📋 todo_list{RESET}  {done}/{len(items)} done {GRAY}[{elapsed()}]{RESET}", flush=True)
            return True

        if item_type == "function_call":
            name = item.get("name", "?")
            args = item.get("arguments", "")
            status = item.get("status", "")

            icon = {"shell": "🔨", "read_file": "📖", "write_file": "✏️ ",
                    "edit_file": "🔧", "list_directory": "📂",
                    "grep_search": "🔍", "web_search": "🌐"}.get(name, "⚙️")

            detail = ""
            if isinstance(args, str):
                try:
                    args_obj = json.loads(args) if args else {}
                except:
                    args_obj = {}
            elif isinstance(args, dict):
                args_obj = args
            else:
                args_obj = {}

            if name == "shell":
                cmd = args_obj.get("command", args_obj.get("cmd", ""))
                if isinstance(cmd, list):
                    cmd = " ".join(cmd)
                if len(cmd) > 70:
                    cmd = cmd[:67] + "..."
                detail = cmd
            elif name in ("read_file", "write_file", "edit_file"):
                fp = args_obj.get("path", args_obj.get("file_path", ""))
                if fp:
                    fp = fp.replace(os.path.expanduser("~"), "~")
                    if len(fp) > 65:
                        fp = ".../" + "/".join(fp.split("/")[-2:])
                    detail = fp
            elif name == "list_directory":
                detail = args_obj.get("path", ".")

            status_icon = ""
            if status == "completed":
                status_icon = f" {GREEN}✓{RESET}"
            elif status == "failed" or status == "error":
                status_icon = f" {RED}✗{RESET}"

            print(f"{CYAN}{icon} {name}{RESET}  {detail}{status_icon} {GRAY}[{elapsed()}]{RESET}", flush=True)
            return True

        if item_type == "function_call_output":
            output = item.get("output", "")
            if output and len(output) > 200:
                output = output[:200] + "..."
            # Only show errors or short outputs
            if item.get("status") == "error" or (output and len(output) < 100):
                if output:
                    print(f"   {GRAY}{output}{RESET}", flush=True)
            return True

        return True  # unknown item type, consume silently

    if msg_type == "turn.completed":
        print(f"\n{GREEN}{'━'*55}{RESET}", flush=True)
        print(f"{GREEN}✅ Codex turn completed{RESET} {GRAY}[{elapsed()}]{RESET}", flush=True)
        print(f"{'━'*55}", flush=True)
        return True

    return False  # not a Codex event


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except json.JSONDecodeError:
        continue

    msg_type = d.get("type", "")

    # Try Codex format first
    if msg_type in ("thread.started", "turn.started", "turn.completed",
                     "item.started", "item.completed"):
        format_codex_event(d)
        continue

    # System init (Claude format)
    if msg_type == "system" and d.get("subtype") == "init":
        init_model = d.get("model", "?")
        cwd = d.get("cwd", "").replace(os.path.expanduser("~"), "~")
        format_banner(model=init_model, cwd=cwd)
        continue

    # Stream events
    if msg_type == "stream_event":
        event = d.get("event", {})
        event_type = event.get("type", "")

        if event_type == "content_block_start":
            block = event.get("content_block", {})
            block_type = block.get("type", "")
            
            if block_type == "thinking":
                flush_block()
                current_block_type = "thinking"
                thinking_chars = 0
                print(f"{MAGENTA}💭 Thinking...{RESET} {GRAY}[{elapsed()}]{RESET}", flush=True)
                
            elif block_type == "text":
                flush_block()
                current_block_type = "text"
                
            elif block_type == "tool_use":
                flush_block()
                current_block_type = "tool_use"
                tool_name = block.get("name", "?")
                tool_input_json = ""

        elif event_type == "content_block_delta":
            delta = event.get("delta", {})
            delta_type = delta.get("type", "")
            
            if delta_type == "thinking_delta":
                text = delta.get("thinking", "")
                if text and thinking_chars < THINKING_MAX_CHARS:
                    remaining = THINKING_MAX_CHARS - thinking_chars
                    show = text[:remaining]
                    sys.stdout.write(f"{GRAY}{show}{RESET}")
                    sys.stdout.flush()
                    thinking_chars += len(text)
                    if thinking_chars >= THINKING_MAX_CHARS:
                        sys.stdout.write(f"{GRAY}...{RESET}")
                        sys.stdout.flush()
                    
            elif delta_type == "text_delta":
                text = delta.get("text", "")
                if text:
                    sys.stdout.write(text)
                    sys.stdout.flush()
                    
            elif delta_type == "input_json_delta":
                tool_input_json += delta.get("partial_json", "")

        elif event_type == "content_block_stop":
            if current_block_type == "tool_use" and tool_name:
                try:
                    inp = json.loads(tool_input_json) if tool_input_json else {}
                except:
                    inp = {}
                
                icon = {"Read": "📖", "Write": "✏️ ", "Edit": "🔧", "Bash": "🔨", 
                        "Glob": "🔍", "Grep": "🔍", "ToolSearch": "🔎",
                        "TodoRead": "📋", "TodoWrite": "📋", "WebSearch": "🌐",
                        "WebFetch": "🌐"}.get(tool_name, "⚙️")
                
                detail = ""
                if tool_name in ("Read", "Write", "Edit"):
                    fp = inp.get("file_path", inp.get("path", ""))
                    if fp:
                        fp = fp.replace(os.path.expanduser("~"), "~")
                        if len(fp) > 65:
                            fp = ".../" + "/".join(fp.split("/")[-2:])
                        detail = fp
                elif tool_name == "Bash":
                    cmd = inp.get("command", "")
                    if len(cmd) > 70:
                        cmd = cmd[:67] + "..."
                    detail = cmd
                elif tool_name == "TodoWrite":
                    todos = inp.get("todos", [])
                    done = sum(1 for t in todos if t.get("status") == "completed")
                    detail = f"{done}/{len(todos)} done"
                elif tool_name == "WebSearch":
                    detail = inp.get("query", "")[:60]
                
                print(f"{CYAN}{icon} {tool_name}{RESET}  {detail} {GRAY}[{elapsed()}]{RESET}", flush=True)
                tool_name = None
                tool_input_json = ""
            else:
                flush_block()

        elif event_type == "message_stop":
            flush_block()

    # Tool results with errors
    elif msg_type == "tool_result":
        is_error = d.get("is_error", False)
        if is_error:
            content = d.get("content", "")
            err = content[:150] if isinstance(content, str) else str(content)[:150]
            print(f"   {RED}❌ {err}{RESET}", flush=True)

    # Final result
    elif msg_type == "result":
        flush_block()
        subtype = d.get("subtype", "")
        duration_ms = d.get("duration_ms", 0)
        cost = d.get("total_cost_usd", 0)
        is_error = d.get("is_error", False)
        result_text = d.get("result", "")
        
        mins, secs = divmod(duration_ms // 1000, 60)
        
        if is_error:
            print(f"\n{RED}{'━'*55}{RESET}", flush=True)
            print(f"{RED}❌ FAILED{RESET} in {mins}m {secs}s | ${cost:.2f}", flush=True)
            if result_text:
                print(f"{RED}{result_text[:400]}{RESET}", flush=True)
        else:
            print(f"\n{GREEN}{'━'*55}{RESET}", flush=True)
            print(f"{GREEN}✅ COMPLETED{RESET} in {mins}m {secs}s | ${cost:.2f}", flush=True)
        print(f"{'━'*55}", flush=True)
        
    # Rate limit
    elif msg_type == "rate_limit_event":
        info = d.get("rate_limit_info", {})
        if info.get("status") != "allowed":
            print(f"\n{YELLOW}⚠️  Rate limited: {info.get('status','?')}{RESET}", flush=True)
