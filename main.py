from api_ga import api_search


def main() -> None:
    card_name = input("Enter card name: ").strip()

    try:
        card_data = api_search(card_name)
        print(card_data)
    except Exception as e:
        print(f"Error: {e}")


if __name__ == "__main__":
    main()