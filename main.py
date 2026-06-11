from api_ga import card_reset, card_search, set_search
from inv_ga import bin_create, bin_delete, bin_edit, bin_list, inv_edit
from pricing_ga import add_listing, add_sale
from user import user_create, user_delete, user_reset
from util_file import new_json

import json

JSON_USERS = "DATA_GENERAL/USERS.json"


def user_exists(username: str) -> bool:
    users_file = new_json(JSON_USERS)
    with users_file.open("r", encoding="utf-8") as f:
        users_data = json.load(f)
    return username in users_data


def menu_inventory(username: str) -> None:
    while True:
        print(f"\nInventory — [ {username} ]")
        print("0. Log Out")
        print("1. View Bins")
        print("2. Edit Card")
        print("3. Edit Bin")
        print("4. Create Bin")
        print("5. Delete Bin")

        choice = input("\nSelect option: ").strip()

        match choice:
            case "0":
                print(f"\nLogged out: {username}")
                return

            case "1":
                bin_list(username)

            case "2":
                card_name = input("\nEnter card name: ").strip()
                inv_edit(username, card_name)

            case "3":
                bin_edit(username)

            case "4":
                bin_create(username)

            case "5":
                bin_delete(username)

            case _:
                print("\nInvalid option.")


def menu_listings() -> None:
    while True:
        print("\nListings & Sales")
        print("0. Back")
        print("1. Add Listing")
        print("2. Add Sale")

        choice = input("\nSelect option: ").strip()

        match choice:
            case "0":
                return

            case "1":
                card_name = input("\nEnter card name: ").strip()
                add_listing(card_name)

            case "2":
                card_name = input("\nEnter card name: ").strip()
                add_sale(card_name)

            case _:
                print("\nInvalid option.")


def menu_users() -> None:
    while True:
        print("\nUsers")
        print("0. Back")
        print("1. Create User")
        print("2. Reset User Password")
        print("3. Delete User")

        choice = input("\nSelect option: ").strip()

        match choice:
            case "0":
                return

            case "1":
                username = input("\nEnter username: ").strip()
                password = input("Enter password: ").strip()

                try:
                    user_create(username, password)
                    print(f"\nCreated user: {username}")
                except ValueError as e:
                    print(f"\n{e}")

            case "2":
                username = input("\nEnter username: ").strip()
                password = input("Enter new password: ").strip()
                user_reset(username, password)

            case "3":
                username = input("\nEnter username: ").strip()
                user_delete(username)

            case _:
                print("\nInvalid option.")


def main() -> None:
    while True:
        print("\nGA Library")
        print("0. Exit")
        print("1. Search Card")
        print("2. Search Set")
        print("3. Listings & Sales")
        print("4. Users")
        print("9. Reset Card")
        print("\nOr enter a username to log in.")

        choice = input("\nSelect option: ").strip()

        match choice:
            case "0":
                print("\nGoodbye.")
                break

            case "1":
                card_names = input("\nEnter card name(s) (comma separated): ")
                card_names = [
                    name.strip()
                    for name in card_names.split(",")
                    if name.strip()
                ]
                card_search(card_names, False)

            case "2":
                set_prefix = input("\nEnter set prefix: ").strip().upper()
                set_search(set_prefix, False)

            case "3":
                menu_listings()

            case "4":
                menu_users()

            case "9":
                card_name = input("\nEnter card name to reset: ").strip()
                card_reset(card_name, False)

            case _:
                username = choice
                if user_exists(username):
                    menu_inventory(username)
                else:
                    print(f"\nUser not found: {username}")


if __name__ == "__main__":
    main()
