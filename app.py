from flask import Flask, request, render_template_string
import api_ga

app = Flask(__name__)

HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>GA Card Search</title>
</head>
<body>
    <h1>Grand Archive Card Search</h1>

    <form method="POST">
        <input 
            type="text" 
            name="card_name" 
            placeholder="Enter card name"
            required
        >
        <button type="submit">Search</button>
    </form>

    {% if message %}
        <p><strong>{{ message }}</strong></p>
    {% endif %}

    {% if card_id %}
        <p>Saved Card ID: {{ card_id }}</p>
    {% endif %}
</body>
</html>
"""


@app.route("/", methods=["GET", "POST"])
def index():
    message = None
    card_id = None

    if request.method == "POST":
        card_name = request.form.get("card_name")

        if card_name:
            card_id = api_ga.card_search(card_name)

            if card_id:
                message = f"Card saved successfully: {card_name}"
            else:
                message = f"Card not found: {card_name}"

    return render_template_string(
        HTML,
        message=message,
        card_id=card_id
    )


if __name__ == "__main__":
    app.run(debug=True)
