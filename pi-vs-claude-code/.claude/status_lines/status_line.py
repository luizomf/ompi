#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "python-dotenv",
# ]
# ///

"""
Status Line v6.5 - Minimal Context Window
Display: [Model] [###---] 42.5%
Stripped-down v6 — model name, progress bar, percent only.
"""

import json
import sys

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass  # dotenv is optional


# ANSI color codes
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
DIM = "\033[90m"
RESET = "\033[0m"


def get_usage_color(percentage):
    """Get color based on usage percentage."""
    if percentage < 50:
        return GREEN
    elif percentage < 75:
        return YELLOW
    elif percentage < 90:
        return RED
    else:
        return "\033[91m"  # Bright red for critical


def create_progress_bar(percentage, width=15):
    """Create a visual progress bar."""
    filled = int((percentage / 100) * width)
    empty = width - filled

    color = get_usage_color(percentage)

    bar = f"{color}{'#' * filled}{DIM}{'-' * empty}{RESET}"
    return f"[{bar}]"


def generate_status_line(input_data):
    """Generate the minimal context window status line."""
    model_info = input_data.get("model", {})
    model_name = model_info.get("display_name", "Claude")

    context_data = input_data.get("context_window", {})
    used_percentage = context_data.get("used_percentage", 0) or 0

    usage_color = get_usage_color(used_percentage)

    parts = [
        f"{CYAN}[{model_name}]{RESET}",
        create_progress_bar(used_percentage),
        f"{usage_color}{used_percentage:.1f}%{RESET}",
    ]

    return " ".join(parts)


def main():
    try:
        input_data = json.loads(sys.stdin.read())
        print(generate_status_line(input_data))
        sys.exit(0)
    except json.JSONDecodeError:
        print(f"{RED}[Claude] Error: Invalid JSON{RESET}")
        sys.exit(0)
    except Exception as e:
        print(f"{RED}[Claude] Error: {str(e)}{RESET}")
        sys.exit(0)


if __name__ == "__main__":
    main()
