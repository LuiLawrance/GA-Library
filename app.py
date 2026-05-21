from flask import Flask, render_template, request, send_from_directory
from pathlib import Path
import api_ga
import json

app = Flask(__name__)


@app.route("/", methods=["GET", "POST"])
def index():
    card_images = []

    if request.method == "POST":
        raw_search = request.form.get("card_name", "")

        card_names = [
            line.strip()
            for line in raw_search.splitlines()
            if line.strip()
        ]

        for card_name in card_names:
            card_id = api_ga.card_search(card_name)

            if not card_id:
                continue

            path = api_ga.file.new_json(api_ga.PATH_CARDS)

            with open(path, "r", encoding="utf-8") as f:
                cards = json.load(f)

            card_data = cards.get(card_id, {})

            for edition in card_data.get("editions", []):
                edition_id = edition.get("uuid")

                if edition_id:
                    card_images.append(f"/images/{edition_id}.jpg")

    return render_template(
        "search.html",
        card_images=card_images
    )


@app.route("/images/<filename>")
def serve_image(filename):
    image_folder = Path(api_ga.PATH_IMAGES)
    return send_from_directory(image_folder, filename)


if __name__ == "__main__":
    app.run(debug=True)
