from api_ga import card_search, set_search
from pricing_ga import add_listing, add_sale
from user import user_create, user_delete, user_login, user_reset


def main() -> None:
    current_user = None

    while True:
        print("\nGA Library")

        if current_user:
            print(f"Logged in as: {current_user}")
            print("0. Log Out")

            choice = input("\nSelect option: ").strip()

            if choice == "0":
                print(f"\nLogged out: {current_user}")
                current_user = None

            continue

        print("0. Exit")
        print("1. Search Card")
        print("2. Search Set")
        print("3. Add Listing")
        print("4. Add Sale")
        print("5. Create User")
        print("6. Reset User Password")
        print("7. Delete User")

        choice = input("\nSelect option: ").strip()

        if choice == "0":
            print("\nGoodbye.")
            break

        if choice not in {"1", "2", "3", "4", "5", "6", "7"}:
            username = choice
            password = input("Enter password: ").strip()
            current_user = user_login(username, password)

            if not current_user:
                print("\nLogin failed.")

            continue

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
                card_name = input("\nEnter card name: ").strip()
                add_listing(card_name)

            case "4":
                card_name = input("\nEnter card name: ").strip()
                add_sale(card_name)

            case "5":
                username = input("\nEnter username: ").strip()
                password = input("Enter password: ").strip()

                user_create(username, password)

            case "6":
                username = input("\nEnter username: ").strip()
                password = input("Enter new password: ").strip()

                user_reset(username, password)

            case "7":
                username = input("\nEnter username: ").strip()

                user_delete(username)

            case _:
                print("\nInvalid option.")
                continue

        break


if __name__ == "__main__":
    main()
