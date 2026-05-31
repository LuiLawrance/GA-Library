from pathlib import Path

import json


# Create a directory and any missing parent directories.
def new_dir(path: str, debug: bool = False) -> Path:
    directory_path = Path(path)
    existed_before = directory_path.exists()

    directory_path.mkdir(parents=True, exist_ok=True)

    if debug:
        if existed_before:
            print(f"Directory already exists: {directory_path}")
        else:
            print(f"Created directory: {directory_path}")

    return directory_path


# Create an empty JSON file and any missing parent directories.
def new_json(path: str, debug: bool = False) -> Path:
    file_path = Path(path)

    # Reuse new_dir to create the parent directory
    new_dir(str(file_path.parent), debug=False)

    existed_before = file_path.exists()

    if not existed_before:
        with file_path.open("w", encoding="utf-8") as f:
            json.dump({}, f, indent=4)

    if debug:
        if existed_before:
            print(f"JSON file already exists: {file_path}")
        else:
            print(f"Created JSON file: {file_path}")

    return file_path
