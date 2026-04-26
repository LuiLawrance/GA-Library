from pathlib import Path
import json

PROJECT_ROOT = Path.cwd()


def _safe_project_path(path_str: str) -> Path:
    full_path = (PROJECT_ROOT / path_str).resolve()

    try:
        full_path.relative_to(PROJECT_ROOT.resolve())
    except ValueError:
        raise ValueError("Path must be inside the project directory.")

    return full_path


def new_dir(path_str: str) -> Path:
    """
    Create a directory (and any necessary parent directories).

    Example:
    new_dir("DATA_CLIENT/GA_USERS")
    """

    dir_path = _safe_project_path(path_str)

    # Create directory (and parents) if they don't exist
    dir_path.mkdir(parents=True, exist_ok=True)

    print(f"Directory ensured: {dir_path}")

    return dir_path


def new_json(path_str: str) -> Path:
    """
    Create a JSON file and any necessary parent directories.

    Example:
    new_json("DATA_CLIENT/GA_CARDS/GA_CARDS.json")
    """

    file_path = _safe_project_path(path_str)

    # Ensure .json extension
    if file_path.suffix != ".json":
        file_path = file_path.with_suffix(".json")

    # Create parent directories if they don't exist
    file_path.parent.mkdir(parents=True, exist_ok=True)

    # Create file if it doesn't exist
    if not file_path.exists():
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump({}, f, indent=4)

        print(f"Created: {file_path}")

    return file_path
