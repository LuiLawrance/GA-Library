from flask import Flask, request, render_template_string, send_from_directory
from pathlib import Path
import api_ga
import json

app = Flask(__name__)

HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>GA Card Search</title>

    <style>
        .autocomplete-items {
            border: 1px solid #ccc;
            max-width: 300px;
            position: absolute;
            background: white;
            z-index: 99;
        }

        .autocomplete-items div {
            padding: 8px;
            cursor: pointer;
        }

        .autocomplete-items div:hover {
            background-color: #eee;
        }
    </style>
</head>
<body>
    <h1>Grand Archive Card Search</h1>

    <form method="POST" autocomplete="off">
        <div style="position:relative;">
            <input
                id="cardInput"
                type="text"
                name="card_name"
                placeholder="Enter card name"
                required
                style="width: 300px;"
            >
            <div id="autocomplete-list" class="autocomplete-items"></div>
        </div>

        <button type="submit">Search</button>
    </form>

    {% if error %}
        <p><strong>{{ error }}</strong></p>
    {% endif %}

    {% if images %}
        <h2>{{ card_name }}</h2>

        {% for image in images %}
            <img src="{{ image }}" style="width:250px; margin:10px;">
        {% endfor %}
    {% endif %}

<script>
const names = {{ saved_names | tojson }};

const input = document.getElementById("cardInput");
const list = document.getElementById("autocomplete-list");

input.addEventListener("input", function() {
    const value = this.value.toLowerCase();
    list.innerHTML = "";

    if (!value) return;

    names.forEach(name => {
        if (name.toLowerCase().includes(value)) {
            const item = document.createElement("div");
            item.textContent = name;

            item.addEventListener("click", function() {
                input.value = name;
                list.innerHTML = "";
            });

            list.appendChild(item);
        }
    });
});

document.addEventListener("click", function(e) {
    if (e.target !== input) {
        list.innerHTML = "";
    }
});
</script>

</body>
</html>
"""


def load_card_names():
    path = api_ga.file.new_json(api_ga.PATH_NAMES)

    try:
        with open(path, "r", encoding="utf-8") as f:
            names_data = json.load(f)
    except json.JSONDecodeError:
        return []

    return sorted(names_data.keys())


@app.route("/", methods=["GET", "POST"])
def index():
    error = None
    images = []
    card_name = None

    if request.method == "POST":
        card_name = request.form.get("card_name", "").strip()

        card_id = api_ga.card_search(card_name)

        if not card_id:
            error = "A card does not exist."
        else:
            path = api_ga.file.new_json(api_ga.PATH_CARDS)

            with open(path, "r", encoding="utf-8") as f:
                cards = json.load(f)

            card_data = cards.get(card_id, {})

            for edition in card_data.get("editions", []):
                uuid = edition.get("uuid")

                if uuid:
                    images.append(f"/images/{uuid}.jpg")

            if not images:
                error = "A card does not exist."

    return render_template_string(
        HTML,
        error=error,
        images=images,
        card_name=card_name,
        saved_names=load_card_names()
    )


@app.route("/images/<filename>")
def images(filename):
    image_folder = Path(api_ga.PATH_IMAGES)
    return send_from_directory(image_folder, filename)


if __name__ == "__main__":
    app.run(debug=True)
