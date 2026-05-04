from flask import Flask, request, render_template, send_from_directory, redirect, url_for, session
from pathlib import Path
import api_ga
import user
import json

app = Flask(__name__)
app.secret_key = "change-this-secret-key"


def load_card_names() -> list[str]:
    path = api_ga.file.new_json(api_ga.PATH_NAMES)

    try:
        with open(path, "r", encoding="utf-8") as f:
            names_data = json.load(f)
    except json.JSONDecodeError:
        return []

    saved_names: list[str] = []

    for key, value in names_data.items():
        if isinstance(value, dict):
            saved_names.append(str(value.get("name", key)))
        elif isinstance(value, str):
            saved_names.append(str(key))

    return sorted(saved_names, key=lambda name: name.lower())


@app.route("/", methods=["GET", "POST"])
def index():
    error = None
    card_images = []
    display_name = None

    if request.method == "POST":
        search_name = request.form.get("card_name", "").strip()
        display_name = search_name

        card_id = api_ga.card_search(search_name)

        if not card_id:
            error = "A card does not exist."
        else:
            path = api_ga.file.new_json(api_ga.PATH_CARDS)

            with open(path, "r", encoding="utf-8") as f:
                cards = json.load(f)

            card_data = cards.get(card_id, {})
            display_name = card_data.get("name", search_name)

            for edition in card_data.get("editions", []):
                uuid = edition.get("uuid")

                if uuid:
                    card_images.append(f"/images/{uuid}.jpg")

            if not card_images:
                error = "A card does not exist."

    return render_template(
        "index.html",
        error=error,
        card_images=card_images,
        display_name=display_name,
        saved_names=load_card_names(),
        username=session.get("username")
    )


@app.route("/images/<filename>")
def serve_image(filename):
    image_folder = Path(api_ga.PATH_IMAGES)
    return send_from_directory(image_folder, filename)


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    message = None

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        action = request.form.get("action")

        if action == "login":
            logged_in_user = user.user_login(username, password)

            if logged_in_user:
                session["username"] = logged_in_user
                return redirect(url_for("index"))

            error = "Username or password is incorrect."

        elif action == "create":
            created = user.new_user(username, password)

            if created:
                session["username"] = username
                return redirect(url_for("index"))

            error = "That username already exists."

    return render_template(
        "login.html",
        error=error,
        message=message
    )


@app.route("/logout")
def logout():
    session.pop("username", None)
    return redirect(url_for("index"))


if __name__ == "__main__":
    app.run(debug=True)
