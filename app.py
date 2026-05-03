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

        .autocomplete-active {
            background-color: #ddd;
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

    {% if card_images %}
        <h2>{{ display_name }}</h2>

        {% for image in card_images %}
            <img src="{{ image }}" style="width:250px; margin:10px;">
        {% endfor %}
    {% endif %}

<script>
const names = {{ saved_names | tojson }};

const input = document.getElementById("cardInput");
const list = document.getElementById("autocomplete-list");

let currentFocus = -1;

window.onload = function() {
    input.value = "";
    list.innerHTML = "";
    input.focus();
};

input.addEventListener("input", function() {
    const value = this.value.toLowerCase();
    list.innerHTML = "";
    currentFocus = -1;

    if (value.length < 2) return;

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

input.addEventListener("keydown", function(e) {
    let items = list.getElementsByTagName("div");

    if (e.key === "ArrowDown") {
        currentFocus++;
        addActive(items);
        e.preventDefault();
    } else if (e.key === "ArrowUp") {
        currentFocus--;
        addActive(items);
        e.preventDefault();
    } else if (e.key === "Enter") {
        if (currentFocus > -1 && items[currentFocus]) {
            e.preventDefault();
            items[currentFocus].click();
        }
    }
});

function addActive(items) {
    if (!items.length) return;

    removeActive(items);

    if (currentFocus >= items.length) currentFocus = 0;
    if (currentFocus < 0) currentFocus = items.length - 1;

    items[currentFocus].classList.add("autocomplete-active");
}

function removeActive(items) {
    for (let i = 0; i < items.length; i++) {
        items[i].classList.remove("autocomplete-active");
    }
}

document.addEventListener("click", function(e) {
    if (e.target !== input) {
        list.innerHTML = "";
    }
});
</script>

</body>
</html>
"""


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

    return render_template_string(
        HTML,
        error=error,
        card_images=card_images,
        display_name=display_name,
        saved_names=load_card_names()
    )


@app.route("/images/<filename>")
def serve_image(filename):
    image_folder = Path(api_ga.PATH_IMAGES)
    return send_from_directory(image_folder, filename)


if __name__ == "__main__":
    app.run(debug=True)
