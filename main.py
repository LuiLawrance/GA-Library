from api_ga import card_search, set_search
from pricing_ga import add_listing, add_sale


def main() -> None:
    print("\nGA Library")
    print("1. Search Card")
    print("2. Search Set")
    print("3. Add Listing")
    print("4. Add Sale")

    choice = input("\nSelect option: ").strip()

    match choice:
        case "1":
            card_names = input(
                "\nEnter card name(s) (comma separated): "
            )

            card_names = [
                card_name.strip()
                for card_name in card_names.split(",")
                if card_name.strip()
            ]

            card_search(card_names, False)

        case "2":
            set_prefix = input("\nEnter set prefix: ").strip().upper()

            set_search(set_prefix, False)

        case "3":
            edition_id = input("\nEnter edition ID: ").strip()
            foil_id = input("Enter foil ID: ").strip()
            marketplace = input("Enter marketplace: ").strip()
            price = float(input("Enter price: ").strip())
            info = input("Enter info: ").strip()

            add_listing(edition_id, foil_id, marketplace, price, info)

        case "4":
            edition_id = input("\nEnter edition ID: ").strip()
            foil_id = input("Enter foil ID: ").strip()
            marketplace = input("Enter marketplace: ").strip()
            price = float(input("Enter price: ").strip())
            info = input("Enter info: ").strip()

            add_sale(edition_id, foil_id, marketplace, price, info)

        case _:
            print("\nInvalid option.")


if __name__ == "__main__":
    main()
