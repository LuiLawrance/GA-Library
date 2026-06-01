from api_ga import card_search


def main() -> None:
    card_names_input = input(
        "Enter card names (comma separated): "
    ).strip()

    card_names = [
        name.strip()
        for name in card_names_input.split(",")
        if name.strip()
    ]

    card_search(card_names)


if __name__ == "__main__":
    main()
