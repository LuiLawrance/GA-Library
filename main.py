from api_ga import card_search, set_search


def main() -> None:
    print("\nGA Library")
    print("1. Search Card")
    print("2. Search Set")

    choice = input("\nSelect option: ").strip()

    match choice:
        case "1":
            card_names = input(
                "\nEnter card name(s) "
                "(comma separated): "
            )

            card_names = [
                card_name.strip()
                for card_name in card_names.split(",")
                if card_name.strip()
            ]

            card_search(card_names, False)

        case "2":
            set_prefix = input(
                "\nEnter set prefix: "
            ).strip().upper()

            set_search(set_prefix, False)

        case _:
            print("\nInvalid option.")


if __name__ == "__main__":
    main()
